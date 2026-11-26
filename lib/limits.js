/**
 * 并发、限速与自适应策略（从下载器拆出的可复用模块）。
 *
 * 三件事彼此独立、可以单独取用：
 * - ConnectionSlots / RateLimiter：全局连接配额与令牌桶限速；
 * - LoadGovernor / ResourceSampler：按 CPU、内存压力收缩并逐步恢复连接预算；
 * - SiteGovernor / SiteLimiter：按站点（注册域）独立降档、冷却与限速。
 */
import { cpus as osCpus, freemem as osFreemem, totalmem as osTotalmem } from 'node:os'

/**
 * 设备负载自适应：每 2 秒采样一次系统 CPU 与内存占用。
 * 压力 = max(CPU 使用率, 内存压力)；超过阈值收缩连接预算，回落后逐步抬回。
 *
 * 有两个坑必须在判定里挡掉，否则低配机器上会出现「上限 5、实际只有 1 条连接」：
 * - Windows 的 os.freemem() 把系统缓存算成已用，空闲机器也常年 90%+；
 *   直接当压力就会把预算永久压到 1。因此内存只在「接近耗尽」时才算压力：
 *   空闲物理内存还有 1.5 GiB 就一律忽略，否则使用率要到 88% 才开始计入。
 * - 下载刚起第一波连接时，TLS 握手会让 CPU 尖一下，而单个采样窗口只有 2 秒。
 *   一次尖峰不足以证明机器撑不住，所以收缩前要求连续两个采样都高于阈值；
 *   为此多等的 2 秒远好过把预算压到最低后再缓慢爬回来。
 */
const LOAD_SAMPLE_MS = 2000
const LOAD_RECOVER_BELOW = 55
const LOAD_RECOVER_STREAK = 2
/** 内存使用率低于此值不参与压力判定。 */
const LOAD_MEMORY_BRAKE_AT = 88
/** 空闲物理内存高于此值时，内存占用率再高也不代表吃紧（大内存机器的文件缓存）。 */
const LOAD_MEMORY_SAFE_BYTES = 1536 * 1024 * 1024
/** 档位按压力从高到低匹配：factor 为可用连接预算比例。 */
const LOAD_STEPS = [
  { at: 95, factor: 0.2, level: 'critical' },
  { at: 85, factor: 0.35, level: 'high' },
  { at: 70, factor: 0.6, level: 'elevated' },
  { at: 55, factor: 0.8, level: 'elevated' },
]
/**
 * 站点风控自适应档位：cap = 该站点同时连接上限（0 = 不额外限制），
 * rate = 该站点聚合限速（字节/秒，0 = 不限），cooldownMs = 命中风控后暂停请求的时长。
 */
const SITE_LEVELS = [
  { cap: 0, rate: 0, cooldownMs: 0 },
  { cap: 4, rate: 2 * 1024 * 1024, cooldownMs: 3000 },
  { cap: 2, rate: 768 * 1024, cooldownMs: 8000 },
  { cap: 1, rate: 256 * 1024, cooldownMs: 20000 },
  { cap: 1, rate: 128 * 1024, cooldownMs: 60000 },
]
/** 视为「被风控」的响应：403 防盗链/拦截、429 明确限流、503 站点过载。 */
const RISK_STATUS = new Set([403, 429, 503])
/** 单个任务因站点风控而整体重试的上限；超过后按失败处理并说明原因。 */
const RISK_RETRY_LIMIT = 3
/** 站点每档位需要连续多少段成功才回升一档，避免刚放行又被风控。 */
const SITE_REWARD_PER_LEVEL = 24
const MAX_TRACKED_SITES = 64

/** 全局令牌桶限速；rate 为字节/秒，0 表示不限。 */
class RateLimiter {
  constructor(rate) {
    this.rate = rate
    this.tokens = 0
    this.last = Date.now()
    this.chain = Promise.resolve()
  }

  setRate(rate) {
    this.rate = rate
    this.last = Date.now()
    this.tokens = 0
  }

  take(bytes) {
    if (this.rate <= 0 || bytes <= 0) return Promise.resolve()
    this.chain = this.chain.then(async () => {
      const now = Date.now()
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate)
      this.last = now
      this.tokens -= bytes
      if (this.tokens >= 0) return
      const wait = Math.max(1, Math.ceil((-this.tokens / this.rate) * 1000))
      this.tokens = 0
      await sleep(wait)
      this.last = Date.now()
    })
    return this.chain
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 可被 AbortSignal 打断的等待：暂停或取消时立即返回，不拖住连接槽。 */
function abortableSleep(ms, signal) {
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      done()
    }
    const timer = setTimeout(finish, Math.max(0, ms))
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

/** 常见的两级公共后缀：这些站点保留三段，其余只保留最后两段。 */
const MULTI_LABEL_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'com.hk', 'com.tw', 'com.mo',
  'com.sg', 'com.my', 'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.ru', 'com.ua', 'com.pl',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'or.kr',
  'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'co.in', 'net.in', 'org.in',
  'co.za', 'co.il', 'com.sa', 'com.eg', 'com.ng', 'co.id', 'co.th', 'in.th',
])
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * 多租户托管域名：`a.github.io` 与 `b.github.io` 是两个不同站点，
 * 不能按最后两段归并，否则其中一方被风控降档会误伤另一方。
 */
const MULTI_TENANT_SUFFIXES = [
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 'r2.dev', 'fly.dev',
  's3.amazonaws.com', 'storage.googleapis.com', 'blob.core.windows.net',
  'aliyuncs.com', 'myqcloud.com', 'glitch.me', 'repl.co',
]

/**
 * 站点键：把「同一个网站」归并成一个键，用于风控策略。
 * 刻意宽松——同一站点的不同页面、不同子域（cdn / www / img）都落到同一个键，
 * 否则 A 站两个页面各自计数，等于用两套策略撞同一面墙。
 */
function siteKeyForUrl(raw) {
  let url
  try {
    url = raw instanceof URL ? raw : new URL(String(raw ?? '').trim())
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host === '') return ''
  // GitHub 的下载直链会跳到 api / objects.githubusercontent 等域，统一按一个站点治理。
  if (host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com')) return 'github.com'
  if (host.startsWith('[') || host.includes(':')) return host.replace(/^\[|\]$/g, '')
  if (IPV4_PATTERN.test(host)) return host
  // 多租户后缀下每个子域是独立站点，保留完整主机名。
  if (MULTI_TENANT_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return host
  const labels = host.split('.').filter((label) => label !== '')
  if (labels.length <= 2) return labels.join('.')
  const suffix = labels.slice(-2).join('.')
  return MULTI_LABEL_SUFFIXES.has(suffix) ? labels.slice(-3).join('.') : suffix
}

/** 读取一次 CPU 累计时间片（idle 与 total）。 */
function readCpuTimes() {
  let idle = 0
  let total = 0
  for (const cpu of osCpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { idle, total }
}

/** 两次采样之间的 CPU 使用率（百分比）；采样间隔太短时返回 null。 */
function cpuPercentBetween(before, after) {
  if (before === null || before === undefined || after === null || after === undefined) return null
  const total = after.total - before.total
  const idle = after.idle - before.idle
  if (!(total > 0)) return null
  return Math.max(0, Math.min(100, (1 - idle / total) * 100))
}

/** 系统内存使用率（百分比）。 */
function memoryPercent() {
  const total = osTotalmem()
  const free = osFreemem()
  if (!(total > 0)) return null
  return Math.max(0, Math.min(100, (1 - free / total) * 100))
}

/**
 * 把内存使用率折算成「压力百分比」：88% 以下不算压力，88→100 线性放大到 0→100。
 * freeBytes 有值时优先信它——空闲内存还很充裕，说明高占用只是系统缓存。
 */
function memoryPressurePercent(memoryPct, freeBytes = undefined) {
  const used = Number(memoryPct)
  if (!Number.isFinite(used)) return 0
  const free = Number(freeBytes)
  if (Number.isFinite(free) && free >= LOAD_MEMORY_SAFE_BYTES) return 0
  if (used <= LOAD_MEMORY_BRAKE_AT) return 0
  return Math.min(100, ((used - LOAD_MEMORY_BRAKE_AT) / (100 - LOAD_MEMORY_BRAKE_AT)) * 100)
}

/** 按压力选择档位；压力不足 55 时视为正常。 */
function loadStepFor(pressure) {
  for (const step of LOAD_STEPS) if (pressure >= step.at) return step
  return { factor: 1, level: 'normal' }
}

/**
 * 设备负载调节器：把「用户设定的连接上限」压成一个当前可用预算。
 * - 高负载：连续两个采样成立后收缩（避开握手尖峰）；
 * - 没有连接在跑：直接回到用户设定值，空闲机器没有要保护的东西；
 * - 资源充裕：每两个采样周期抬一步（约基础值的 1/4），不会立刻打回满速。
 */
class LoadGovernor {
  constructor(baseLimit, enabled = true) {
    this.base = Math.max(1, Math.round(baseLimit) || 1)
    this.enabled = enabled !== false
    this.limit = this.base
    this.level = 'normal'
    this.cpuPct = null
    this.memoryPct = null
    this.memoryPressure = 0
    this.pressure = null
    this.hotStreak = 0
    this.lowStreak = 0
    this.idle = true
    this.lastSampleAt = 0
  }

  setBase(limit) {
    this.base = Math.max(1, Math.round(limit) || 1)
    this.limit = Math.min(this.limit, this.base)
    if (!this.enabled) this.limit = this.base
    return this.limit
  }

  setEnabled(enabled) {
    this.enabled = enabled !== false
    this.lowStreak = 0
    return this.refresh()
  }

  /**
   * 记录一次采样。
   * @param {number} cpuPct 系统 CPU 使用率
   * @param {number} memoryPct 系统内存使用率
   * @param {{ active?: boolean, freeBytes?: number, now?: number }} [options]
   *   active=false：当前没有任何在跑的连接，预算直接回到设定值。
   */
  observe(cpuPct, memoryPct, options = {}) {
    const opts = options !== null && typeof options === 'object' ? options : {}
    this.cpuPct = Number.isFinite(cpuPct) ? cpuPct : null
    this.memoryPct = Number.isFinite(memoryPct) ? memoryPct : null
    this.memoryPressure = memoryPressurePercent(this.memoryPct, opts.freeBytes)
    this.pressure = Math.max(this.cpuPct ?? 0, this.memoryPressure)
    this.idle = opts.active === false
    this.lastSampleAt = Number.isFinite(opts.now) ? opts.now : Date.now()
    this.hotStreak = this.pressure >= LOAD_RECOVER_BELOW ? this.hotStreak + 1 : 0
    return this.refresh(this.lastSampleAt)
  }

  refresh(now = Date.now()) {
    if (!this.enabled) {
      this.level = 'normal'
      this.limit = this.base
      this.lowStreak = 0
      return this.limit
    }
    if (this.idle) {
      // 没有连接在跑时收缩没有意义，只会让下一次任务带着一个被压低的预算起步。
      this.level = 'normal'
      this.limit = this.base
      this.lowStreak = 0
      this.hotStreak = 0
      this.updatedAt = now
      return this.limit
    }
    const pressure = this.pressure ?? 0
    const step = loadStepFor(pressure)
    this.level = step.level
    const desired = Math.max(1, Math.min(this.base, Math.round(this.base * step.factor)))
    if (desired < this.limit) {
      // 连续两个采样都超阈值才收缩：单次尖峰（握手、杀毒扫描、索引）只记账不动作。
      if (this.hotStreak >= 2) {
        this.limit = desired
        this.lowStreak = 0
      }
    } else if (desired > this.limit && pressure < LOAD_RECOVER_BELOW) {
      this.lowStreak += 1
      if (this.lowStreak >= LOAD_RECOVER_STREAK) {
        const stride = Math.max(1, Math.round(this.base * 0.25))
        this.limit = Math.min(desired, this.base, this.limit + stride)
        this.lowStreak = 0
      }
    } else if (pressure >= LOAD_RECOVER_BELOW) {
      this.lowStreak = 0
    }
    this.updatedAt = now
    return this.limit
  }
}

/** 定时采样系统 CPU / 内存，回调给 LoadGovernor。 */
class ResourceSampler {
  constructor(callback, intervalMs = LOAD_SAMPLE_MS) {
    this.callback = callback
    this.intervalMs = Math.max(500, Math.round(intervalMs) || LOAD_SAMPLE_MS)
    this.timer = null
    this.previous = readCpuTimes()
  }

  start() {
    if (this.timer !== null) return
    this.previous = readCpuTimes()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  tick() {
    const current = readCpuTimes()
    const cpuPct = cpuPercentBetween(this.previous, current)
    this.previous = current
    this.callback({
      cpuPct,
      memoryPct: memoryPercent(),
      freeBytes: osFreemem(),
      takenAt: Date.now(),
    })
  }
}

/**
 * 全局连接配额（信号量）。每次分片请求先占一个槽，读完正文再归还，
 * 因此「任务数 × 线程数」受同一个上限约束；排队按先来后到，暂停/取消的任务
 * 从队列里摘掉，不会一直占着位置。
 */
class ConnectionSlots {
  constructor(limit) {
    this.limit = Math.max(1, Math.round(limit) || 1)
    this.used = 0
    this.waiters = []
  }

  setLimit(limit) {
    this.limit = Math.max(1, Math.round(limit) || 1)
    this.wake()
  }

  /** 空闲时立即占槽；满了就排队，signal 中止时出队并返回 null。 */
  acquire(signal) {
    if (signal?.aborted === true) return Promise.resolve(null)
    if (this.used < this.limit) {
      this.used += 1
      return Promise.resolve(() => this.release())
    }
    return new Promise((resolve) => {
      const waiter = { resolve, signal, onAbort: null }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          resolve(null)
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  release() {
    this.used = Math.max(0, this.used - 1)
    this.wake()
  }

  wake() {
    while (this.used < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (waiter.signal?.aborted === true) {
        waiter.resolve(null)
        continue
      }
      if (waiter.onAbort !== null) waiter.signal.removeEventListener('abort', waiter.onAbort)
      this.used += 1
      waiter.resolve(() => this.release())
    }
  }
}

/**
 * 单个站点的风控策略：一份独立的连接槽 + 一份独立的聚合限速。
 * 同一站点的所有任务共用它，所以「A 站两个页面」也会一起被限，而不是各自撞墙；
 * 不同站点之间互不影响。
 */
class SiteLimiter {
  constructor(key) {
    this.key = key
    this.level = 0
    this.slots = new ConnectionSlots(1)
    this.limiter = new RateLimiter(0)
    this.notBefore = 0
    this.successes = 0
    this.signals = 0
    this.lastStatus = 0
    this.lastSignalAt = 0
    this.updatedAt = 0
  }

  get spec() {
    return SITE_LEVELS[this.level] ?? SITE_LEVELS[SITE_LEVELS.length - 1]
  }

  get cap() {
    return this.spec.cap
  }

  get rateBytes() {
    return this.spec.rate
  }

  /** 命中风控：升一档（并发更低、限速更紧、冷却更久），返回新档位。 */
  penalize(status, now = Date.now()) {
    this.level = Math.min(SITE_LEVELS.length - 1, this.level + 1)
    this.signals += 1
    this.lastStatus = status
    this.lastSignalAt = now
    this.successes = 0
    const spec = this.spec
    this.slots.setLimit(Math.max(1, spec.cap))
    this.limiter.setRate(spec.rate)
    // 冷却带 0..400ms 抖动，避免冷却结束瞬间所有分片同时开火。
    this.notBefore = now + spec.cooldownMs + Math.floor(Math.random() * 400)
    this.updatedAt = now
    return spec
  }

  /** 成功读完一段：连续足够多次后回落一档，逐步恢复并发与带宽。 */
  reward(now = Date.now()) {
    if (this.level === 0) {
      this.successes = 0
      return 0
    }
    this.successes += 1
    if (this.successes < SITE_REWARD_PER_LEVEL * this.level) return this.level
    this.successes = 0
    this.level -= 1
    const spec = this.spec
    this.slots.setLimit(Math.max(1, spec.cap))
    this.limiter.setRate(spec.rate)
    this.updatedAt = now
    return this.level
  }

  async waitCooldown(signal) {
    const wait = this.notBefore - Date.now()
    if (wait <= 0) return
    await abortableSleep(wait, signal)
  }

  /** 占一个站点连接（含冷却等待）；signal 中止时返回 null。 */
  async acquire(signal) {
    if (signal?.aborted === true) return null
    await this.waitCooldown(signal)
    if (signal?.aborted === true) return null
    if (this.cap <= 0) return () => {}
    return this.slots.acquire(signal)
  }

  snapshot() {
    return {
      key: this.key,
      level: this.level,
      connections: this.cap,
      rateBytes: this.rateBytes,
      cooldownUntil: this.notBefore,
      signals: this.signals,
      lastStatus: this.lastStatus,
    }
  }
}

/** 站点风控策略表：按注册域归并，每个站点一套独立限制。 */
class SiteGovernor {
  constructor(enabled = true) {
    this.enabled = enabled !== false
    this.sites = new Map()
  }

  setEnabled(enabled) {
    this.enabled = enabled !== false
    if (!this.enabled) this.reset()
  }

  reset() {
    for (const site of this.sites.values()) {
      site.level = 0
      site.slots.setLimit(1)
      site.limiter.setRate(0)
      site.notBefore = 0
      site.successes = 0
    }
    this.sites.clear()
  }

  limiterFor(url) {
    const key = siteKeyForUrl(url)
    if (key === '') return null
    let site = this.sites.get(key)
    if (site === undefined) {
      if (this.sites.size >= MAX_TRACKED_SITES) {
        // 淘汰最早建立、且已恢复正常的站点，避免长时间运行后无限增长。
        for (const [candidate, entry] of this.sites) {
          if (entry.level === 0) {
            this.sites.delete(candidate)
            break
          }
        }
      }
      site = new SiteLimiter(key)
      this.sites.set(key, site)
    }
    return site
  }

  /** 命中风控时调用；关闭站点自适应时返回 null，调用方按原逻辑处理。 */
  penalize(url, status) {
    if (!this.enabled) return null
    const site = this.limiterFor(url)
    if (site === null) return null
    const spec = site.penalize(status)
    return { ...spec, key: site.key, level: site.level, cooldownUntil: site.notBefore }
  }

  reward(url) {
    if (!this.enabled) return
    this.limiterFor(url)?.reward()
  }

  /** 只回传正在被限速的站点，正常站点不占面板空间。 */
  snapshot() {
    return [...this.sites.values()]
      .filter((site) => site.level > 0)
      .map((site) => site.snapshot())
  }
}

export {
  LOAD_SAMPLE_MS,
  LOAD_RECOVER_BELOW,
  LOAD_RECOVER_STREAK,
  LOAD_MEMORY_BRAKE_AT,
  LOAD_MEMORY_SAFE_BYTES,
  LOAD_STEPS,
  SITE_LEVELS,
  RISK_STATUS,
  RISK_RETRY_LIMIT,
  SITE_REWARD_PER_LEVEL,
  MAX_TRACKED_SITES,
  RateLimiter,
  sleep,
  abortableSleep,
  siteKeyForUrl,
  readCpuTimes,
  cpuPercentBetween,
  memoryPercent,
  memoryPressurePercent,
  loadStepFor,
  LoadGovernor,
  ResourceSampler,
  ConnectionSlots,
  SiteLimiter,
  SiteGovernor,
}
