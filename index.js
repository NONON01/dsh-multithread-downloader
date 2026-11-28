/**
 * 多线程下载器 —— Host 半边。
 *
 * 以 HTTP Range 分片并发下载到本地文件，向 Web GUI 暴露 /api/mtd/* 路由，
 * 并向 agent 注册 `downloader` 工具。UI 与工具调用同一套 Downloader 方法。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  NATIVE_PICKER,
  SETTINGS_SCHEMA_VERSION,
  autoThreadsForBytes,
  browseDirectory,
  defaultDownloadDirectory,
  electronDialog,
  filenameFromUrl,
  freeDiskBytes,
  pickNativeDirectory,
  readSettingsFile,
  sanitizeFilename,
  uniqueName,
} from './lib/files.js'
import {
  MAX_ATTEMPTS,
  USER_AGENT,
  describeHttpError,
  fetchWithRedirects,
  fingerprintChange,
  headersForRedirect,
  httpErrorFor,
  httpStatusOf,
  ifRangeValue,
  isRetryable,
  isHtmlContentType,
  looksLikeHtmlBlock,
  parseGithubReleaseUrl,
  parseHttpUrl,
  probe,
  resolveGithubAsset,
  retryDelay,
  sanitizeHeaders,
  signedUrlExpiry,
  strongEtag,
} from './lib/net.js'
import { CHECKSUM_ALGORITHMS, fileChecksum, fileSha256, normalizeChecksum } from './lib/checksum.js'
import {
  ConnectionSlots,
  LoadGovernor,
  RISK_RETRY_LIMIT,
  RISK_STATUS,
  RateLimiter,
  ResourceSampler,
  SITE_LEVELS,
  SITE_DECAY_MS,
  SITE_RISK_DEDUP_MS,
  SiteGovernor,
  SiteLimiter,
  cpuPercentBetween,
  loadStepFor,
  memoryPressurePercent,
  siteKeyForUrl,
  sleep,
} from './lib/limits.js'
import { DOH_PROVIDERS, createDohDispatcher, ipFamilyOf, normalizeDohProvider, resolverFor } from './lib/doh.js'

const API_PREFIX = '/api/mtd'
const MAX_THREADS = 16
const MAX_TASKS = 100
/**
 * 全局并发上限（连接数）：并发 = 任务数 × 每条任务的线程数。
 * 用户可在面板调整，Agent 自主模式同样受它约束；设备高负载时实际生效值会被临时调低。
 */
const DEFAULT_MAX_CONNECTIONS = 16
const MAX_CONNECTIONS = 64
/** 同时活跃的任务数上限，避免大量任务各占一个文件句柄；实际还受连接预算约束。 */
const MAX_ACTIVE_TASKS = 32
/** 每个连接一次最多读这么多，读完让出槽位，保证多任务在预算内轮转而不是被一个任务占满。 */
const CONNECTION_PIECE_BYTES = 4 * 1024 * 1024
const MIN_CHUNK_BYTES = 512 * 1024
/**
 * 还值得一分为二的最小剩余量：两半各 256 KB。
 *
 * 收尾时最后剩下的几段往往只有 1 MB 出头，如果按「两半都得有一个分片那么大」，
 * 就一段都切不动了 —— 连接明明空着，尾巴却由 4 条连接慢慢啃。
 * 单连接被限速（300 KB/s）时，256 KB 也要跑将近 1 秒，多一次请求换一条连接的活是划算的；
 * 而带宽已经吃满的站点本来就不会走到这条分支（单连接速度够高时不允许爬升）。
 */
const MIN_SPLIT_BYTES = 256 * 1024
/**
 * 分片数爬升：任务起步后的分片数不是终局。
 *
 * 起步分片数由「大小阶梯 4/6/8」或显式线程数决定，但很多站点的瓶颈是**每条连接被限速**
 * （单线程 300 KB/s），而不是总带宽：4 条连接只能跑 1.2 MB/s，而全局预算里还空着十几条。
 * 早先的做法是分片数在探测后就固定了，低并发起步的任务永远追不回来。这里每 3 秒（起步阶段
 * 每 1.2 秒）复核一次，满足条件就把一个分片的剩余区间对半切开、立刻多起一条连接 ——
 * 已下载的字节原地保留，不需要「重启任务」把它们丢掉重下。
 *
 * 并发上限管的是**同时在用的连接数**，不是分片条数：先跑完的分片会把连接交还回来，
 * 让位出去的剩余区间再交给它接着跑，所以收尾时每条连接都是满的，分片条数可能超过上限。
 */
const EXPAND_INTERVAL_MS = 3000
/** 头两次复核（爬升步数少于这个值）用更短的间隔，别让起步的低并发白白耗掉前几秒。 */
const EXPAND_FIRST_INTERVAL_MS = 1200
/** 爬升到这个步数之前都算「起步阶段」，复核用短间隔。 */
const EXPAND_RAMP_STEPS = 4
/** 已下载达到这个比例就算收尾：只在尾巴已经不够再切时才停止爬升。 */
const EXPAND_PROGRESS_MAX = 0.6
/** 剩余不足这个量级就算收尾（文件本身更小时按总量的一半再收一次），同上。 */
const EXPAND_MIN_REMAINING_BYTES = 8 * 1024 * 1024
/** 每次复核最多加几条连接：加得太急会和站点限速叠加，反而更容易撞风控。 */
const EXPAND_PER_TICK = 2
/** 每条连接平均低于这个速度，才认为瓶颈在「单连接被限速」而不是带宽已经吃满。 */
const EXPAND_SLOW_PER_CONNECTION_BPS = 640 * 1024
/** 自动阶梯（4/6/8）之外，爬升允许到达的上限；显式指定的线程数仍按指定值固定。 */
const ESCALATE_MAX_THREADS = 8
/** 超过该大小的任务才记录并返回进度采样历史（面板据此绘制曲线）。 */
const DEFAULT_LARGE_FILE_MB = 16
const DEFAULT_MIN_THREAD_MB = 4
/**
 * 进度曲线点数上限（面板响应体预算）。采样分两档：
 * - 细档 `HISTORY_FINE` 个点，每秒一个，覆盖最近两分钟；
 * - 粗档 `HISTORY_COARSE` 个桶，覆盖全程，桶满一次就整体合并、每格时长翻倍。
 * 于是几小时的任务也能看到完整曲线，点数与响应体大小都不变。丢掉最老的点只会剩下
 * 「开头一点 + 一大段空白」，所以这里用折叠而不是截断。
 */
const HISTORY_LIMIT = 240
const HISTORY_FINE = 120
const HISTORY_COARSE = HISTORY_LIMIT - HISTORY_FINE
const DISK_MARGIN_BYTES = 32 * 1024 * 1024
/**
 * 分片正文空闲超时：服务端回了响应头却迟迟不发数据（弱网、半死连接、中间设备黑洞），
 * 不能让这个分片永远占着全局连接槽。超过这个时间没有新字节就中断并重试。
 */
const BODY_IDLE_TIMEOUT_MS = 30_000
/**
 * 短包风暴阈值：一次 Range 请求要了好几 MB，服务端却每次只回一小截。
 * 少量来回是正常的（服务端喜欢按固定块回），连续这么多次只回不到 64 KB 就不正常了，
 * 继续下去只是用几千个请求打远端。实测被代理吞掉 Range 时每次回 83 字节。
 */
const SHORT_STREAM_MIN_BYTES = 64 * 1024
const SHORT_STREAM_LIMIT = 8
/**
 * 停滞看门狗。正文空闲超时只管「一个字节都不来」；连接半死却还在涓流时
 * （实测 4 B/s：速度 10 B/s、ETA 两天、状态一直是「下载中」）它永远不会触发。
 * 这里改看窗口吞吐：一个窗口内收到的字节低于下限，就换一组新连接重试；
 * 换两次仍旧如此就标记「远端极慢」，继续下载而不是判失败。
 */
const STALL_WINDOW_MS = 60_000
const STALL_MIN_BYTES = 64 * 1024
const STALL_MAX_RESETS = 2
/** 低于这个速度不报 ETA：算出来的量级是「两天」，不如直说极慢。 */
const SLOW_SPEED_BPS = 1024
/**
 * 跟随重定向后的最终地址复用时长上限。
 * GitHub Release 资产走 api.github.com 时每次请求都会吃掉 60 次/小时的配额，
 * 而 302 指向的签名地址本身支持 Range、有效期约 1 小时，所以分片直接打它；
 * 没带过期时间的普通跳转按这个时长保守缓存。
 */
const REDIRECT_REUSE_MS = 5 * 60_000
/** 最终地址到期前提前这么久就重新解析，避免最后几个分片撞上 403。 */
const REDIRECT_EXPIRY_MARGIN_MS = 60_000
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** 读取配置值并做最简单的类型收敛。 */
function numberConfig(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** 并发限制数（连接数）收敛到合法区间。 */
function clampConnections(value) {
  return numberConfig(value, DEFAULT_MAX_CONNECTIONS, 1, MAX_CONNECTIONS)
}

/** 给用户看的小体积数值（只有 KB / MB / GB 三档，够用了）。 */
function formatBytesCompact(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`
  if (value < 1024 * 1024 * 1024) return `${Math.round(value / (1024 * 102.4)) / 10} MB`
  return `${Math.round(value / (1024 * 1024 * 102.4)) / 10} GB`
}

/**
 * 解析 206 的 Content-Range：`bytes <start>-<end>/<total>`，总长未知时是 `*`。
 * 解析不出来返回 null——调用方必须把「解析不出来」当成「无法验证区间」处理。
 */
function parseContentRange(raw) {
  const match = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(String(raw ?? ''))
  if (match === null) return null
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return { start, end, total: match[3] === '*' ? 0 : Number(match[3]) }
}

/** 目标本身是不是网页：是的话 HTML 正文就是正常内容，不能按软拦截处理。 */
function isHtmlFilename(name) {
  return /\.(?:html?|xhtml)$/i.test(String(name ?? ''))
}

/** 正文开头是不是 HTML 文档标记（拦截页、登录页、错误页都长这样）。 */
function startsWithHtml(buffer) {
  if (buffer === null || buffer === undefined || buffer.length === 0) return false
  // 只看开头 64 字节：BOM 与空白之后仍以 <!doctype html / <html 开头就算。
  const head = Buffer.from(buffer.subarray(0, Math.min(buffer.length, 64)))
    .toString('latin1').replace(/^\uFEFF/, '').trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}

/** 正文是否以标记开头（`<`）。配合错误的 content-type 判定软拦截用。 */
function startsWithMarkup(buffer) {
  if (buffer === null || buffer === undefined || buffer.length === 0) return false
  const head = Buffer.from(buffer.subarray(0, Math.min(buffer.length, 64)))
    .toString('latin1').replace(/^\uFEFF/, '').trimStart()
  return head.startsWith('<')
}

/** 当前 profile 目录：优先环境变量，退回 ~/.dsh/profiles/<name>。 */
function resolveProfileDirectory() {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const name = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : 'desktop'
  return join(homedir(), '.dsh', 'profiles', name)
}

/** 一个下载任务。 */
class DownloadTask {
  constructor(manager, input) {
    this.manager = manager
    this.id = input.id
    this.urls = Array.isArray(input.urls) && input.urls.length > 0 ? input.urls : [input.url]
    this.url = this.urls[0]
    this.urlIndex = 0
    this.headers = input.headers ?? {}
    this.checksum = input.checksum ?? null
    this.sourceUrl = input.sourceUrl ?? this.urls[0]
    this.github = input.github === true
    this.forceDisplay = input.forceDisplay === true
    this.doh = input.doh === true
    this.dohProvider = input.dohProvider ?? 'alidns'
    this.dir = input.dir
    this.requestedName = input.filename
    this.threads = input.threads
    this.threadsExplicit = input.threadsExplicit === true
    this.singleThread = input.singleThread
    this.origin = input.origin === 'user' ? 'user' : 'agent'
    this.etag = ''
    this.lastModified = ''
    this.rangeFallback = false
    /**
     * 跟随重定向后缓存的最终地址（例如 GitHub 302 到签名 CDN、镜像站 302 到对象存储）。
     * 复用它能省掉每次分片都走一遍 302 的往返与配额消耗；到期或失效时回退到原地址。
     */
    this.remoteUrl = ''
    this.remoteHeaders = {}
    this.remoteExpiresAt = 0
    this.remoteChecked = false
    this.remotePending = null
    /** 指纹状态：''（无校验值）/ verified / unverified / changed。 */
    this.fingerprintState = ''
    this.fingerprintNote = ''
    /** 站点风控：本次任务已因风控整体重试的次数，以及给用户看的说明。 */
    this.riskRetries = 0
    this.riskNote = ''
    this.lastRiskAt = 0
    this.freshRestart = false
    this.superseded = false
    this.resetFile = false
    /** 416 只允许重建分片一次，避免与远端互相拉扯成死循环。 */
    this.rangeRebuild = false
    /** 每一轮 runChunks 的令牌；旧轮发现令牌变了就安静退出。 */
    this.runToken = null
    this.status = 'queued'
    this.error = ''
    this.filename = input.filename
    this.path = ''
    this.partPath = ''
    this.totalBytes = 0
    this.receivedBytes = 0
    this.speed = 0
    /** 平滑后的速度，只用于预估剩余时间：秒级瞬时速度抖动太大会让 ETA 乱跳。 */
    this.etaSpeed = 0
    this.progress = 0
    this.createdAt = Date.now()
    this.startedAt = 0
    this.finishedAt = 0
    this.chunks = []
    /** 起步分片数（大小阶梯或显式线程数），爬升只能在这个数之上、上限之内加。 */
    this.planThreads = 0
    /** 本次任务通过爬升额外加出来的分片数，仅用于展示与测试观测。 */
    this.expansions = 0
    /**
     * 实际同时在跑的连接数峰值。
     * 收尾时为了让空闲连接接着干活，分片总数会超过并发上限（一个分片跑完了，
     * 另一个还长的分片让出一半），所以「分片条数」不等于「用过几条连接」。
     */
    this.peakConnections = 0
    /** 扩容时用来给新分片起一条流的回调，由 runChunksBody 的监督循环提供。 */
    this.spawnChunk = null
    this.handle = null
    this.abort = new AbortController()
    this.sampler = null
    this.lastSample = 0
    this.lastSampleAt = 0
    /** 进度曲线：粗档（全程，每格 historyStep 秒）+ 细档（最近两分钟，每秒一点）。 */
    this.history = []
    this.recent = []
    this.historyStep = 1
    /** 停滞看门狗：自动换连接的次数、是否已判定「远端极慢」、给用户看的说明。 */
    this.stallResets = 0
    this.stallSlow = false
    this.stallNote = ''
    /** 每次判定停滞就 +1：在途的分片发现它变了就主动取消，换一条新连接。 */
    this.stallEpoch = 0
    this.stallWindowAt = 0
    this.stallWindowBytes = 0
  }

  get active() {
    return this.status === 'downloading' || this.status === 'probing'
  }

  snapshot(options = {}) {
    const siteKey = siteKeyForUrl(this.url)
    const site = siteKey === '' ? null : this.manager.siteGovernor.sites.get(siteKey)
    const throttled = site !== undefined && site !== null && site.level > 0 ? site : null
    const remainingBytes = this.totalBytes > 0 ? Math.max(0, this.totalBytes - this.receivedBytes) : 0
    // 展示用的线程数 = 当前还在跑的分片数（爬升会变多）；全部跑完后回落成「实际用过的并发」。
    // 不能回落成分片条数：收尾让位会让分片条数超过并发上限（10 个分片、最多 8 条连接）。
    const liveChunks = this.liveChunks()
    const peak = Math.max(1, this.peakConnections || this.threads || 1)
    const live = liveChunks > 0
      ? liveChunks
      : Math.min(Math.max(1, this.chunks.length || this.threads || 1), peak)
    // 预估剩余时间：只在正在下载、速度有效、大小已知时给出，避免给出误导性的 0 或 Infinity。
    // 优先用平滑速度，秒级瞬时速度的抖动会让 ETA 每秒跳一次。
    const rate = this.etaSpeed > 0 ? this.etaSpeed : this.speed
    // 速度低到 1 KB/s 以下时算出来的 ETA 是「两天」这种量级，报出来只会误导。
    const tooSlow = rate > 0 && rate < SLOW_SPEED_BPS
    const etaSeconds = this.status === 'downloading' && rate > 0 && remainingBytes > 0 && !tooSlow
      ? Math.max(1, Math.round(remainingBytes / rate))
      : null
    const snapshot = {
      id: this.id,
      url: this.sourceUrl || this.url,
      dir: this.dir,
      filename: this.filename,
      path: this.path,
      status: this.status,
      error: this.error,
      totalBytes: this.totalBytes,
      receivedBytes: this.receivedBytes,
      remainingBytes,
      progress: this.totalBytes > 0 ? Math.min(1, this.receivedBytes / this.totalBytes) : 0,
      speed: this.speed,
      ...(etaSeconds === null ? {} : { etaSeconds }),
      ...(tooSlow || this.stallSlow ? { slow: true } : {}),
      ...(this.stallNote === '' ? {} : { stallNote: this.stallNote }),
      ...(this.stallResets > 0 ? { stallResets: this.stallResets } : {}),
      threads: throttled === null
        ? live
        : Math.min(live, Math.max(1, throttled.cap)),
      ...(this.expansions > 0 ? { expandedChunks: this.expansions } : {}),
      origin: this.origin,
      doh: this.doh,
      dohProvider: this.dohProvider,
      github: this.github,
      forceDisplay: this.forceDisplay,
      ...(this.checksum === null ? {} : { checksum: { ...this.checksum } }),
      ...(siteKey === '' ? {} : { siteKey }),
      ...(throttled === null
        ? {}
        : {
            siteThrottle: {
              level: throttled.level,
              connections: throttled.cap,
              rateBytes: throttled.rateBytes,
              cooldownUntil: throttled.notBefore,
            },
          }),
      ...(this.riskRetries > 0 ? { riskRetries: this.riskRetries } : {}),
      ...(this.riskNote === '' ? {} : { riskNote: this.riskNote }),
      ...(this.fingerprintState === ''
        ? {}
        : {
            fingerprint: {
              state: this.fingerprintState,
              ...(this.fingerprintNote === '' ? {} : { note: this.fingerprintNote }),
            },
          }),
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    }
    // 仅大文件回传采样历史，避免小任务的轮询负载。
    if (options.history === true && this.manager.shouldDisplay(this)) {
      const points = this.historyPoints()
      if (points.length > 0) snapshot.history = points
    }
    return snapshot
  }

  toRecord() {
    return {
      id: this.id,
      urls: this.urls,
      dir: this.dir,
      filename: this.filename,
      requestedName: this.requestedName,
      path: this.path,
      partPath: this.partPath,
      totalBytes: this.totalBytes,
      chunks: this.chunks,
      etag: this.etag,
      lastModified: this.lastModified,
      headers: this.headers,
      checksum: this.checksum,
      origin: this.origin,
      doh: this.doh,
      dohProvider: this.dohProvider,
      github: this.github,
      forceDisplay: this.forceDisplay,
      threads: this.threads,
      threadsExplicit: this.threadsExplicit,
      planThreads: this.planThreads,
      singleThread: this.singleThread,
      createdAt: this.createdAt,
    }
  }

  /** 曲线快照：粗档（全程）在前、细档（最近两分钟）在后，时间严格递增。 */
  historyPoints() {
    return this.history.concat(this.recent)
  }

  /** 细档溢出：最老的一点落进粗档对应的时间格；同一格里再来就取均值。 */
  spillToCoarse(point) {
    const step = this.historyStep
    const bucket = Math.floor(point.t / step)
    const last = this.history[this.history.length - 1]
    if (last !== undefined && Math.floor(last.t / step) === bucket) {
      this.history[this.history.length - 1] = { t: last.t, p: point.p, s: (last.s + point.s) / 2 }
    } else {
      this.history.push({ t: bucket * step, p: point.p, s: point.s })
    }
    if (this.history.length > HISTORY_COARSE) this.coarsenHistory()
  }

  /** 粗档也满了：每格时长翻倍，相邻两格合并成一格（速度取均值），全程不丢。 */
  coarsenHistory() {
    this.historyStep *= 2
    const step = this.historyStep
    const merged = []
    for (const point of this.history) {
      const bucket = Math.floor(point.t / step)
      const last = merged[merged.length - 1]
      if (last !== undefined && Math.floor(last.t / step) === bucket) {
        last.p = point.p
        last.s = (last.s + point.s) / 2
      } else {
        merged.push({ t: bucket * step, p: point.p, s: point.s })
      }
    }
    this.history = merged
  }

  recordHistory(now) {
    if (!this.manager.shouldDisplay(this)) return
    const elapsed = Math.max(0, Math.floor((now - this.startedAt) / 1000))
    const last = this.recent.length > 0 ? this.recent[this.recent.length - 1] : this.history[this.history.length - 1]
    if (last !== undefined && last.t >= elapsed) return
    this.recent.push({
      t: elapsed,
      p: Math.round(this.progress * 1000) / 1000,
      s: this.speed,
    })
    while (this.recent.length > HISTORY_FINE) this.spillToCoarse(this.recent.shift())
  }

  startSampler() {
    this.stopSampler()
    this.lastSample = this.receivedBytes
    this.lastSampleAt = Date.now()
    // 暂停一段时间后恢复，窗口起点还是旧的会让看门狗把「暂停的那几分钟」算成停滞。
    this.stallWindowAt = 0
    this.stallWindowBytes = this.receivedBytes
    this.sampler = setInterval(() => {
      const now = Date.now()
      const elapsed = Math.max(1, now - this.lastSampleAt) / 1000
      const bytes = this.receivedBytes
      const delta = Math.max(0, bytes - this.lastSample)
      const instant = Math.round(delta / elapsed)
      this.speed = instant
      // ETA 用指数平滑速度：网络本身就有毫秒级抖动，直接用瞬时速度会给出乱跳的「约剩」。
      this.etaSpeed = this.etaSpeed > 0
        ? Math.round(this.etaSpeed * 0.6 + instant * 0.4)
        : instant
      this.lastSample = bytes
      this.lastSampleAt = now
      this.progress = this.totalBytes > 0 ? Math.min(1, bytes / this.totalBytes) : 0
      this.checkStall(now)
      this.recordHistory(now)
    }, 1000)
    this.sampler.unref?.()
  }

  stopSampler() {
    if (this.sampler !== null) {
      clearInterval(this.sampler)
      this.sampler = null
    }
    this.speed = 0
    this.etaSpeed = 0
  }

  begin() {
    if (this.status !== 'queued') return
    this.status = 'probing'
    this.run().catch((error) => this.fail(error))
  }

  dispatcher() {
    return this.doh ? this.manager.dohAgent(this.dohProvider) : undefined
  }

  /** 分片文件旁的指纹旁证：即使任务记录损坏也能判断这份分片属于哪个版本。 */
  get metaPath() {
    return this.path === '' ? '' : `${this.path}.mtd-meta`
  }

  currentFingerprint() {
    return { size: this.totalBytes, etag: this.etag, lastModified: this.lastModified }
  }

  hasValidator() {
    return this.etag !== '' || this.lastModified !== ''
  }

  async writeMeta() {
    const path = this.metaPath
    if (path === '') return
    try {
      const payload = JSON.stringify({
        version: 1,
        url: this.url,
        size: this.totalBytes,
        etag: this.etag,
        lastModified: this.lastModified,
        startedAt: this.createdAt,
      }, null, 2)
      await writeFile(path, payload, 'utf8')
    } catch {
      // 旁证写不进去只影响续传校验的严格程度，不阻断下载。
    }
  }

  async readMeta() {
    const path = this.metaPath
    if (path === '') return null
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return null
    }
  }

  async removeMeta() {
    const path = this.metaPath
    if (path === '') return
    await unlink(path).catch(() => {})
  }

  /** 当前正在使用的地址（镜像回退后会切换）。 */
  currentUrl() {
    return this.urls[this.urlIndex % this.urls.length]
  }

  /**
   * 实际请求目标：跟随重定向后的最终地址。
   *
   * 很多站点会 302 到 CDN 或对象存储（GitHub Release 资产是 api.github.com → 签名 CDN），
   * 每次分片都重走一遍跳转意味着两倍往返；GitHub 的 API 跳转还会计入 60 次/小时的配额，
   * 分片一多就直接 403，进而被站点风控降到单连接。这里把最终地址连同按跨源规则
   * 剥过凭据的请求头一起缓存，到期前所有分片直接打它，失效后再回到原地址重新解析。
   */
  async remoteTarget() {
    if (this.remoteUrl !== '' && Date.now() < this.remoteExpiresAt) {
      return { url: this.remoteUrl, headers: this.remoteHeaders }
    }
    // 探测时已经跟完重定向、确认原地址就是最终地址：直接用它，不要每个分片再探一次。
    if (this.remoteChecked) return { url: this.currentUrl(), headers: this.headers }
    if (this.remotePending !== null) return this.remotePending
    const origin = this.currentUrl()
    this.remotePending = (async () => {
      const result = await probe(origin, this.abort.signal, this.headers, this.dispatcher())
      return this.rememberTarget(origin, result)
    })()
    try {
      return await this.remotePending
    } finally {
      this.remotePending = null
    }
  }

  /** 记住一次探测得到的最终地址；同源、非 http(s) 或即将过期时继续用原地址。 */
  rememberTarget(origin, result) {
    this.forgetTarget()
    this.remoteChecked = true
    const finalUrl = typeof result?.finalUrl === 'string' ? result.finalUrl : ''
    if (finalUrl === '' || finalUrl === origin) return { url: origin, headers: this.headers }
    let parsed
    try {
      parsed = new URL(finalUrl)
    } catch {
      return { url: origin, headers: this.headers }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { url: origin, headers: this.headers }
    }
    const expiry = signedUrlExpiry(parsed) || Date.now() + REDIRECT_REUSE_MS
    // 已经过期的签名地址没有复用价值：继续走原地址，让服务端重新签一个。
    if (expiry - REDIRECT_EXPIRY_MARGIN_MS <= Date.now()) return { url: origin, headers: this.headers }
    this.remoteUrl = finalUrl
    this.remoteHeaders = headersForRedirect(this.headers, origin, finalUrl)
    this.remoteExpiresAt = expiry - REDIRECT_EXPIRY_MARGIN_MS
    return { url: finalUrl, headers: this.remoteHeaders }
  }

  forgetTarget() {
    this.remoteUrl = ''
    this.remoteHeaders = {}
    this.remoteExpiresAt = 0
    this.remoteChecked = false
  }

  /**
   * 记录一次站点风控。同一波并发分片会同时收到 403，这里按 2 秒窗口去重，
   * 让一波失败只降一档；返回 'exhausted' 表示该任务已经降无可降。
   */
  registerSiteRisk(url, status, reason = '') {
    const now = Date.now()
    if (now - this.lastRiskAt < 2000) return 'retry'
    if (this.riskRetries >= RISK_RETRY_LIMIT) return 'exhausted'
    this.riskRetries += 1
    this.lastRiskAt = now
    const spec = this.manager.siteGovernor.penalize(url, status)
    if (spec !== null) {
      const head = reason !== '' ? reason : `HTTP ${status}：站点触发风控`
      this.riskNote = `${head}，已降至 ${spec.cap} 连接 / ${Math.round(spec.rate / 1024)} KB/s，冷却 ${Math.round(spec.cooldownMs / 1000)} 秒后继续（第 ${this.riskRetries} 次）`
    }
    return 'retry'
  }

  async probeAny() {
    let lastError
    for (;;) {
      let risk = null
      for (let index = 0; index < this.urls.length; index += 1) {
        try {
          const site = this.manager.siteAdaptive ? this.manager.siteGovernor.limiterFor(this.urls[index]) : null
          if (site !== null) await site.waitCooldown(this.abort.signal)
          const result = await probe(this.urls[index], this.abort.signal, this.headers, this.dispatcher())
          this.url = this.urls[index]
          this.urlIndex = index
          return result
        } catch (error) {
          lastError = error
          if (this.abort.signal.aborted) throw error
          const status = httpStatusOf(error)
          if (status !== undefined && RISK_STATUS.has(status) && this.manager.siteAdaptive) {
            if (this.registerSiteRisk(this.urls[index], status) === 'exhausted') {
              throw new Error(`${describeHttpError(status)}（站点已限速重试 ${this.riskRetries} 次仍被拒绝）`)
            }
            risk = { url: this.urls[index] }
            break
          }
        }
      }
      if (risk === null) throw lastError
      const site = this.manager.siteGovernor.limiterFor(risk.url)
      if (site !== null) await site.waitCooldown(this.abort.signal)
    }
  }

  async run() {
    // 与分片循环共用令牌：暂停发生在探测阶段、随后立刻 resume 时，会再起一个 run()，
    // 旧 run() 必须能在每个 await 之后发现自己已被取代，否则两轮会各自打开 .mtd-part、
    // 各自覆盖 this.chunks，先完成的那轮 rename 掉临时文件，另一轮再 open 就是 ENOENT。
    const run = Symbol('run')
    this.runToken = run
    try {
      await this.runBody(run)
    } catch (error) {
      // 暂停会 abort 掉在途的探测请求，旧轮抛出的 AbortError 不是任务失败，
      // 也不能在 resume 之后被记到新一轮头上。
      if (this.runToken !== run) return
      throw error
    }
  }

  async runBody(run) {
    // 每次 run() 都要换新的控制器：pause() 会 abort 掉上一轮的，复用会让新探测
    // 立刻以 AbortError 失败（表现为「暂停后再恢复，任务直接失败」）。
    this.abort = new AbortController()
    const result = await this.probeAny()
    if (this.runToken !== run || this.status !== 'probing') return
    // 探测已经跟完一次重定向：把最终地址存下来，后面所有分片直接打它。
    this.rememberTarget(this.url, result)
    this.totalBytes = result.size
    this.etag = result.etag ?? ''
    this.lastModified = result.lastModified ?? ''
    const chosen = this.requestedName !== '' ? this.requestedName : (result.filename || filenameFromUrl(new URL(this.url)))
    const safeName = sanitizeFilename(chosen) || `download-${this.id}.bin`
    if (this.path === '') {
      await mkdir(this.dir, { recursive: true })
      if (this.runToken !== run) return
      this.filename = await this.manager.reserveName(this.dir, safeName)
      if (this.runToken !== run) return
      this.path = join(this.dir, this.filename)
      this.partPath = `${this.path}.mtd-part`
    }
    await mkdir(this.dir, { recursive: true })
    if (this.runToken !== run) return
    if (this.totalBytes > 0) {
      const free = await freeDiskBytes(this.dir)
      if (this.runToken !== run) return
      if (free !== null && free < this.totalBytes + DISK_MARGIN_BYTES) {
        throw new Error(`磁盘空间不足：需要 ${this.totalBytes + DISK_MARGIN_BYTES} 字节，可用 ${free} 字节`)
      }
    }
    // 打开临时文件前再确认一次，避免「已暂停」的任务把文件重新建出来。
    if (this.runToken !== run || this.status !== 'probing') return
    this.handle = await open(this.partPath, 'w+')
    if (this.totalBytes > 0) await this.handle.truncate(this.totalBytes)
    this.chunks = this.buildChunks(result)
    this.fingerprintState = this.hasValidator() ? 'verified' : ''
    this.fingerprintNote = ''
    await this.writeMeta()
    if (this.runToken !== run || this.status !== 'probing') return
    this.status = 'downloading'
    this.startedAt = this.startedAt || Date.now()
    if (this.manager.shouldDisplay(this) && this.historyPoints().length === 0) {
      this.history = [{ t: 0, p: 0, s: 0 }]
    }
    await this.runChunks(run)
  }

  buildChunks(result) {
    const chunks = this.planChunks(result)
    // 起步分片数记下来：爬升只能在这个基础之上、上限之内加，不会把「显式 2 线程」变成 8 条。
    this.planThreads = chunks.length
    return chunks
  }

  planChunks(result) {
    if (!result.ranges || this.totalBytes <= 0) {
      // 服务器不支持 Range：单连接全量下载，不发 Range 头。
      return [{ start: 0, end: -1, cursor: 0, total: this.totalBytes }]
    }
    const userBypass = this.origin === 'user'
    const singleBySize = this.singleThread === undefined
      && !userBypass
      && this.manager.minThreadEnabled
      && this.manager.minThreadBytes > 0
      && this.totalBytes < this.manager.minThreadBytes
    if (this.singleThread === true || singleBySize) {
      // 单连接整段下载（仍用 Range 以支持续传）。
      return [{ start: 0, end: this.totalBytes - 1, cursor: 0, total: this.totalBytes }]
    }
    // 显式线程数优先；否则在开启 autoThreads 时按大小阶梯取一个合理值。
    const target = this.threadsExplicit || !this.manager.autoThreads
      ? this.threads
      : autoThreadsForBytes(this.totalBytes)
    // 单个任务也不能超过全局连接预算，否则「并发 = 任务数 × 线程数」就不成立。
    const budget = Math.max(1, Math.round(this.manager.maxConnections) || 1)
    const count = Math.max(1, Math.min(target, budget, Math.floor(this.totalBytes / MIN_CHUNK_BYTES) || 1))
    const chunkSize = Math.ceil(this.totalBytes / count)
    const chunks = []
    for (let index = 0; index < count; index += 1) {
      const start = index * chunkSize
      const end = Math.min(this.totalBytes - 1, start + chunkSize - 1)
      if (start > end) break
      chunks.push({ start, end, cursor: 0, total: end - start + 1 })
    }
    return chunks
  }

  /** 还在跑（或还没跑完）的分片数：判断并发是否已经到位要看这个，而不是历史条数。 */
  liveChunks() {
    let live = 0
    for (const chunk of this.chunks) {
      if (chunk.end < 0) {
        live += 1
        continue
      }
      if (chunk.start + chunk.cursor <= chunk.end) live += 1
    }
    return live
  }

  /** 记下这一刻真正在连接上跑着的分片数，用来在收尾后如实展示「用了几条连接」。 */
  noteInflight() {
    let live = 0
    for (const chunk of this.chunks) {
      if (chunk.inflight === true) live += 1
    }
    if (live > this.peakConnections) this.peakConnections = live
  }

  /** 此刻真正挂在连接上的分片数；0 表示在等连接槽或站点冷却，不是停滞。 */
  inflightChunks() {
    let live = 0
    for (const chunk of this.chunks) {
      if (chunk.inflight === true) live += 1
    }
    return live
  }

  /**
   * 停滞看门狗的一次判定（每秒由采样器调用）。
   * 只看窗口吞吐而不是「有没有字节」：半死连接每秒来几个字节，永远不会空闲超时。
   */
  checkStall(now) {
    if (this.status !== 'downloading' || this.manager.stallWatchdog !== true) return
    const windowMs = this.manager.stallWindowMs
    if (!(windowMs > 0)) return
    if (this.stallWindowAt === 0) {
      this.stallWindowAt = now
      this.stallWindowBytes = this.receivedBytes
      return
    }
    if (now - this.stallWindowAt < windowMs) return
    const gained = Math.max(0, this.receivedBytes - this.stallWindowBytes)
    this.stallWindowAt = now
    this.stallWindowBytes = this.receivedBytes
    const floor = this.stallFloorBytes(windowMs)
    if (gained >= floor) {
      // 吞吐回来了：把之前的判定清掉，让面板不再挂着「极慢」。
      this.stallNote = ''
      this.stallSlow = false
      return
    }
    // 没挂在连接上（排队/冷却）不算停滞；剩余量不足一个窗口也不必干预。
    if (this.inflightChunks() === 0) return
    if (this.totalBytes > 0 && this.totalBytes - this.receivedBytes < this.manager.stallMinBytes) return
    if (this.stallSlow) return
    if (this.stallResets >= this.manager.stallMaxResets) {
      this.stallSlow = true
      this.stallNote = `远端极慢：最近 ${Math.round(windowMs / 1000)} 秒只收到 ${formatBytesCompact(gained)}，已停止自动换连接`
      return
    }
    this.stallResets += 1
    this.stallEpoch += 1
    this.stallNote = `检测到停滞（最近 ${Math.round(windowMs / 1000)} 秒只收到 ${formatBytesCompact(gained)}），正在换一组连接（${this.stallResets}/${this.manager.stallMaxResets}）`
  }

  /**
   * 判停滞的字节下限。用户自己设的全局限速、或站点风控后的聚合限速，
   * 本来就会把窗口吞吐压到很低——那不是停滞，先把下限按预期吞吐让下来。
   */
  stallFloorBytes(windowMs) {
    const seconds = windowMs / 1000
    let floor = this.manager.stallMinBytes
    const limits = []
    if (this.manager.rateLimitBytes > 0) limits.push(this.manager.rateLimitBytes)
    const siteKey = siteKeyForUrl(this.currentUrl())
    if (siteKey !== '') {
      const site = this.manager.siteGovernor.sites.get(siteKey)
      if (site !== undefined && site !== null && site.level > 0 && site.rateBytes > 0) limits.push(site.rateBytes)
    }
    if (limits.length > 0) floor = Math.min(floor, Math.min(...limits) * seconds * 0.5)
    return Math.max(1, Math.round(floor))
  }

  /** 分片数上限：自动阶梯可以爬到 ESCALATE_MAX_THREADS，显式指定的线程数保持固定。 */
  escalationTarget() {
    if (this.chunks.length === 0) return 1
    // 服务器不支持 Range（end < 0）或已回退单连接：没法把剩余区间切开。
    if (this.chunks.length === 1 && this.chunks[0].end < 0) return 1
    const budget = Math.max(1, Math.round(this.manager.maxConnections) || 1)
    const hard = Math.max(1, Math.min(MAX_THREADS, budget))
    if (this.threadsExplicit) return Math.min(hard, Math.max(1, this.threads))
    if (!this.manager.autoThreads) return Math.min(hard, Math.max(1, this.threads))
    const planned = this.planThreads > 0 ? this.planThreads : this.chunks.length
    return Math.min(hard, Math.max(planned, ESCALATE_MAX_THREADS))
  }

  /** 爬升的间隔与阈值：允许管理器（含测试）覆盖，默认取常量。 */
  expandPolicy() {
    const manager = this.manager
    const pick = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback)
    return {
      intervalMs: Math.max(50, pick(manager.expandIntervalMs, EXPAND_INTERVAL_MS)),
      progressMax: Math.min(1, Math.max(0.05, pick(manager.expandProgressMax, EXPAND_PROGRESS_MAX))),
      minRemainingBytes: Math.max(0, pick(manager.expandMinRemainingBytes, EXPAND_MIN_REMAINING_BYTES)),
      slowPerConnectionBps: Math.max(0, pick(manager.expandSlowPerConnectionBps, EXPAND_SLOW_PER_CONNECTION_BPS)),
    }
  }

  /**
   * 剩余量下限：默认 8 MB，但文件本身更小时按总量的一半算 ——
   * 20 MB 的文件下到 45% 时只剩 11 MB，用 8 MB 的硬门槛会把它挡在爬升之外。
   */
  remainingFloor(policy = this.expandPolicy()) {
    if (!(this.totalBytes > 0)) return policy.minRemainingBytes
    return Math.min(policy.minRemainingBytes, this.totalBytes * 0.5)
  }

  /**
   * 复核一次是否可以爬升：挑一个分片，把它的剩余区间对半切开，
   * 前半段留给原来的分片继续跑，后半段交给新起的连接。切分按字节偏移进行，
   * 已下载的部分一行不动，因此不需要「重置任务」——重置只会把已下的字节重下一遍。
   *
   * 只在「慢、并且真的有连接闲着」时动手：带宽已经吃满（每条连接都很快）、
   * 站点被风控降档、或者全局预算正被别人用着，都不该再加连接。
   *
   * 进度和剩余量的门槛只用来挡「尾巴已经不够再切」的情形 —— 早先它们是硬门槛，
   * 结果到了收尾阶段，先跑完的分片把连接交还回来，剩下的尾巴却还压在一两个分片上慢慢爬。
   * 只要尾巴还够分成两个像样的分片，把空闲连接用起来永远是净赚。
   */
  maybeEscalate() {
    if (this.status !== 'downloading' || this.spawnChunk === null) return false
    if (this.abort.signal.aborted || this.superseded) return false
    if (this.chunks.length === 0) return false
    const target = this.escalationTarget()
    // 用「还没跑完的分片数」判断是否已经到位：已经结束的分片不该继续占着名额。
    if (this.liveChunks() >= target) return false
    const policy = this.expandPolicy()
    const remaining = this.totalBytes > 0 ? Math.max(0, this.totalBytes - this.receivedBytes) : 0
    // 收尾阶段（进度过半、或剩余已低于下限）只保留一个硬门槛：尾巴还得够切开。
    const late = (this.totalBytes > 0 && this.receivedBytes / this.totalBytes >= policy.progressMax)
      || remaining < this.remainingFloor(policy)
    if (late && remaining < MIN_SPLIT_BYTES * 2) return false
    // 还没有速度采样（刚开始、或者一直没有数据进来）时不扩容：没有「单连接被限速」的证据，
    // 而一直失败的情形（416、连不通）加连接只会多出一串无谓请求。
    if (!(this.speed > 0)) return false
    // 平均每条连接的速度还很高：说明带宽（而不是单连接配额）才是瓶颈，加连接只会互相抢。
    if (this.speed / Math.max(1, this.liveChunks()) >= policy.slowPerConnectionBps) return false
    // 站点被降档时瓶颈是站点配额，不是我们的分片数：这时候加连接只会更快撞风控。
    const site = this.manager.siteAdaptive ? this.manager.siteGovernor.limiterFor(this.currentUrl()) : null
    if (site !== null && site.level > 0) return false
    // 没有空闲预算就不抢别人的连接。
    const slots = this.manager.slots
    if (slots !== undefined && slots !== null && slots.used >= slots.limit) return false
    // 只切「不会被在途请求写到」的地方：
    // - 空闲分片：游标之后全是自由区间；
    // - 在途分片：在途那一段（pieceEnd）已经算好并可能正在写，只能从它之后切。
    //   分段只有 4 MB，而慢速连接下一段要跑好几秒，等它跑完再扩容就没意义了。
    let carrier = null
    let carrierLeft = 0
    let carrierCut = 0
    for (const chunk of this.chunks) {
      if (chunk.end < 0) continue
      const position = chunk.start + chunk.cursor
      const pieceEnd = Number(chunk.pieceEnd)
      const guard = chunk.inflight === true
        ? Math.max(position, (Number.isFinite(pieceEnd) && pieceEnd >= 0 ? pieceEnd : position) + 1)
        : position
      const left = chunk.end - guard + 1
      // 两半都要够得着「值得再开一条连接」的尺寸：切出一个 100 KB 的尾巴只会多一次请求。
      if (left < MIN_SPLIT_BYTES * 2 || left <= carrierLeft) continue
      carrier = chunk
      carrierLeft = left
      carrierCut = guard + Math.floor(left / 2)
    }
    if (carrier === null) return false
    const cut = carrierCut
    if (cut > carrier.end) return false
    const originalEnd = carrier.end
    carrier.end = cut - 1
    carrier.total = carrier.end - (carrier.start + carrier.cursor) + 1
    const tail = { start: cut, end: originalEnd, cursor: 0, total: originalEnd - cut + 1 }
    this.chunks.push(tail)
    this.expansions += 1
    this.spawnChunk(tail)
    this.manager.persistTasks?.()
    return true
  }

  /**
   * 当前是否还留着爬升空间：只有这时才值得把分段切细（留出可切分的位置）。
   * 已经到上限（含显式线程数）、或者尾巴已经不够再切时，分段回到 4 MB，
   * 免得为了一个用不上的切分点给每个下载都多加好几次请求。
   */
  splitFriendly() {
    if (this.manager.threadEscalation === false) return false
    if (this.chunks.length === 0) return false
    if (this.chunks.length === 1 && this.chunks[0].end < 0) return false
    if (this.liveChunks() >= this.escalationTarget()) return false
    const policy = this.expandPolicy()
    const remaining = this.totalBytes > 0 ? Math.max(0, this.totalBytes - this.receivedBytes) : 0
    const late = (this.totalBytes > 0 && this.receivedBytes / this.totalBytes >= policy.progressMax)
      || remaining < this.remainingFloor(policy)
    // 收尾阶段照样要留切分点：空闲连接还要靠它接活，只有尾巴太小才放弃。
    if (late && remaining < MIN_SPLIT_BYTES * 2) return false
    return true
  }

  /**
   * 定时复核爬升；任务结束/暂停后自行停止。
   * 定时器只做判定，真正的并发由 runChunk 里的全局配额把关；
   * 每次最多加 EXPAND_PER_TICK 条，避免一次把站点打醒。
   *
   * 头两次复核用更短的间隔：起步并发往往只是「还没爬起来」，
   * 跟第一次复核隔 3 秒，等于白白用低并发下掉前 10% 的文件。
   */
  startExpansion(run) {
    if (this.manager.threadEscalation === false) return { stop() {} }
    const { intervalMs } = this.expandPolicy()
    const firstMs = Math.max(50, Math.min(intervalMs, EXPAND_FIRST_INTERVAL_MS))
    let timer = null
    let stopped = false
    const tick = () => {
      timer = null
      if (stopped) return
      if (this.runToken !== run || this.status !== 'downloading') return
      try {
        for (let step = 0; step < EXPAND_PER_TICK; step += 1) {
          if (!this.maybeEscalate()) break
        }
      } catch {
        // 扩容是优化项：任何异常都不该影响正在进行的下载。
      }
      const wait = this.expansions < EXPAND_RAMP_STEPS ? firstMs : intervalMs
      timer = setTimeout(tick, wait)
      timer.unref?.()
    }
    timer = setTimeout(tick, firstMs)
    timer.unref?.()
    return {
      stop: () => {
        stopped = true
        if (timer !== null) clearTimeout(timer)
      },
    }
  }

  /**
   * 分片循环：每次向全局连接预算占一个槽，读完一小段（4 MB）就归还，
   * 再重新排队，多个任务因此能轮转，而不是先来的任务一口气占满全部预算。
   * 重试退避等待不占槽。所有任务共享同一个预算，Agent 指定的线程数也绕不过它。
   */
  async runChunk(chunk, run) {
    let attempts = 0
    while (this.runToken === run && !this.superseded) {
      const position = chunk.start + chunk.cursor
      if (chunk.end >= 0 && position > chunk.end) return
      const url = this.currentUrl()
      const site = this.manager.siteAdaptive ? this.manager.siteGovernor.limiterFor(url) : null
      // 先占站点槽（含风控冷却），再占全局槽：冷却等待不该攥着全局连接不放，
      // 否则一个被风控的站点会把其它站点的下载一起拖停。
      const siteRelease = site === null ? null : await site.acquire(this.abort.signal)
      if (site !== null && siteRelease === null) return
      // 等槽位期间可能已被 pause/resume 换掉本轮：立刻交还站点槽并退出。
      if (this.runToken !== run) {
        if (siteRelease !== null) siteRelease()
        return
      }
      let slot = null
      let retry = false
      /** 看门狗换连接是健康检查，不是退避：立刻重连，别再多等半秒。 */
      let immediateRetry = false
      let retryAfterMs = 0
      let cooldownUrl = ''
      try {
        slot = await this.manager.slots.acquire(this.abort.signal)
        if (slot === null) return
        if (this.runToken !== run) return
        // 排队期间爬升可能把这个分片的尾巴切给了新连接：拿到槽位后重新读游标，
        // 用已经算好的 position 会越过新的 end，写出一个本不属于本分片的区间。
        const from = chunk.start + chunk.cursor
        if (chunk.end >= 0 && from > chunk.end) return
        // 单连接整段下载没有终点；分片只取一小段，让出槽位给其它任务。
        // 还有爬升空间时分段不超过「本分片剩余量的一半」：一个 4 MB 请求把整段一次吃完时，
        // 中途没有任何时刻可以安全切分，爬升就只能等它跑完（慢速连接下等于永远等不到）。
        const leftInChunk = chunk.end < 0 ? -1 : chunk.end - from + 1
        const pieceBytes = leftInChunk < 0 || !this.splitFriendly()
          ? CONNECTION_PIECE_BYTES
          : Math.max(MIN_CHUNK_BYTES, Math.min(CONNECTION_PIECE_BYTES, Math.ceil(leftInChunk / 2)))
        const pieceEnd = chunk.end < 0 ? -1 : Math.min(chunk.end, from + pieceBytes - 1)
        chunk.inflight = true
        // 记下在途区间：爬升只允许从这段之后切，否则正在写的这一段会被切走。
        chunk.pieceEnd = pieceEnd
        this.noteInflight()
        try {
          await this.pullChunk(chunk, from, pieceEnd, site, run)
        } finally {
          chunk.inflight = false
          chunk.pieceEnd = -1
        }
        // 这一段成功，退避计数清零：同一个分片的后续小段从头计数；
        // 站点连续成功够了就回落一档，恢复并发与带宽。
        attempts = 0
        if (site !== null) site.reward()
        // 单连接整段下载（服务器不支持 Range）读到 EOF 就结束这一轮。
        // 少了这一句，while 会以每秒几十次的速度把整个文件重下一遍。
        if (chunk.end < 0) return
      } catch (error) {
        // 本轮已被换掉（pause 后立刻 resume、或重启重开）：不要动新一轮的状态。
        if (this.runToken !== run) return
        // 已有分片发现远端变化：其它分片安静退出，由 runChunks 统一重开。
        if (this.superseded) {
          if (error?.code === 'FINGERPRINT_CHANGED') throw error
          return
        }
        if (this.status !== 'downloading' || this.abort.signal.aborted) return
        const status = httpStatusOf(error)
        const timedOut = error?.name === 'AbortError' && !this.abort.signal.aborted
        if (error?.code === 'STALL_RESET') {
          // 看门狗换连接不算网络失败：不消耗重试预算、不退避，直接从当前游标重来。
          // 多地址时顺便换一个镜像，半死的往往是某一条线路。
          attempts = 0
          retry = true
          immediateRetry = true
          if (this.urls.length > 1) {
            this.urlIndex = (this.urlIndex + 1) % this.urls.length
            this.forgetTarget()
          }
        } else if (error?.code === 'TARGET_STALE') {
          // 缓存的重定向地址过期：重新解析后再来。既不算站点风控，也不算网络失败。
          attempts += 1
          if (attempts >= MAX_ATTEMPTS) throw error
          retry = true
        } else if (error?.code === 'SOFT_BLOCKED') {
          // 软拦截（HTTP 200/206 里的 HTML 拦截页）和 403 一样按站点风控处理：
          // 降档、冷却、换镜像，重试几次仍然如此才报错，并说清真正的可能原因。
          if (this.registerSiteRisk(url, 403, '远端返回 HTML 拦截页') === 'exhausted') {
            throw new Error(
              '远端返回的是 HTML 页面而不是文件正文（可能是 WAF 拦截页或登录页，'
              + `已重试 ${this.riskRetries} 次）：请在 headers 里补充 Cookie / Referer，或稍后再试`,
            )
          }
          cooldownUrl = url
          attempts = 0
          retry = true
          if (this.urls.length > 1) {
            this.urlIndex = (this.urlIndex + 1) % this.urls.length
            this.forgetTarget()
          }
        } else if (error?.code === 'RANGE_MISMATCH' || error?.code === 'RANGE_OVERFLOW') {
          // 服务端给的区间不可信（没有 Content-Range、起点错位、正文超长）。
          // 这是协议层问题，不是网络抖动：直接交给收尾逻辑退回单连接整段下载，
          // 那条路径从 0 读到 EOF，内容可验证。
          throw error
        } else if (status !== undefined && RISK_STATUS.has(status) && this.manager.siteAdaptive) {
          // 站点风控：降档 + 冷却后再来，重试预算与网络重试分开计。
          if (this.registerSiteRisk(url, status) === 'exhausted') {
            throw new Error(`${describeHttpError(status)}（站点已降速重试 ${this.riskRetries} 次仍被拒绝；`
              + '若浏览器能打开，请把 Cookie / Referer 通过 headers 传入）')
          }
          cooldownUrl = url
          attempts = 0
          retry = true
          // 429 的 Retry-After 比站点档位里的冷却更长时，按服务端要求等。
          retryAfterMs = Number(error?.retryAfterMs) || 0
        } else if (!timedOut && !isRetryable(error, status)) {
          throw error
        } else {
          attempts += 1
          if (attempts >= MAX_ATTEMPTS) throw error
          if (this.urls.length > 1) {
            this.urlIndex = (this.urlIndex + 1) % this.urls.length
            this.forgetTarget()
          }
          retry = true
          retryAfterMs = Number(error?.retryAfterMs) || 0
        }
      } finally {
        if (slot !== null) slot()
        if (siteRelease !== null) siteRelease()
      }
      // 冷却在槽位之外等待：让其它站点的任务继续跑。
      if (cooldownUrl !== '') {
        const cooled = this.manager.siteGovernor.limiterFor(cooldownUrl)
        if (cooled !== null) await cooled.waitCooldown(this.abort.signal)
      }
      /**
       * 无 Range（chunk.end < 0）的流式端点在重试时不能从游标续写：
       * 服务端会从 0 重新发整份正文，写进 cursor 之后的位置就是错位文件。
       * 这条路径没法「从中间续」，唯一安全的重试是从头来一遍。
       */
      if (retry && chunk.end < 0) await this.resetStreamRestart()
      if (retry && !immediateRetry) await sleep(retryDelay(attempts, retryAfterMs))
    }
  }

  /**
   * 把无 Range 的单流从头重来：截断临时文件、游标归零。
   * 只用于 chunk.end < 0 的分片——那条路径的正文总是从 0 开始，
   * 保留游标续写会把第二遍的开头写到上一遍的中间，交付出错位文件。
   */
  async resetStreamRestart() {
    if (this.handle !== null) await this.handle.truncate(0).catch(() => {})
    for (const item of this.chunks) {
      if (item.end < 0) item.cursor = 0
    }
    this.receivedBytes = 0
    this.progress = 0
    this.history = this.manager.shouldDisplay(this) ? [{ t: 0, p: 0, s: 0 }] : []
    this.recent = []
  }

  /**
   * 服务器对 Range 请求回了 200 时，用响应里的指纹判断到底是「换了版本」还是
   * 「压根不支持 Range」。拿不到可比较的指纹时返回 false：单连接重下总能拿到正确文件，
   * 而错判成版本变化会让任务在「重开后仍然 200」的循环里失败。
   */
  remoteChanged(freshEtag, freshModified) {
    // 弱 ETag 的 `W/` 前缀不参与比较：W/"x" 与 "x" 是同一个版本，直接比字符串会误判成版本变化。
    if (freshEtag !== '' && this.etag !== '') return strongEtag(freshEtag) !== strongEtag(this.etag)
    if (freshModified !== '' && this.lastModified !== '') return freshModified !== this.lastModified
    return false
  }

  /** 一次分段请求：发 Range、校验响应状态、把正文写进分片文件。 */
  async pullChunk(chunk, position, pieceEnd, site = null, run = null) {
    let release = null
    try {
      const target = await this.remoteTarget()
      if (this.runToken !== run || this.status !== 'downloading') return
      // 跨源跳转后不能把 Cookie / Authorization 继续发过去，headersForRedirect 已剥掉。
      const headers = { 'accept-encoding': 'identity', 'user-agent': USER_AGENT, ...target.headers }
      // 续传/分片请求带上 If-Range：远端换了版本时服务器回 200，我们据此重新开始，而不是拼错内容。
      const ifRange = chunk.end >= 0 ? ifRangeValue(this.etag, this.lastModified) : ''
      if (pieceEnd >= 0) {
        headers.range = `bytes=${position}-${pieceEnd}`
        if (ifRange !== '') headers['if-range'] = ifRange
      }
      const usingCachedTarget = target.url !== this.currentUrl()
      const fetched = await fetchWithRedirects(target.url, { headers, dispatcher: this.dispatcher() }, this.abort.signal)
      release = fetched.release
      const response = fetched.response
      if (response.status === 401 || response.status === 403 || response.status === 407) {
        await response.body?.cancel().catch(() => {})
        // 缓存的签名直链过期/失效：丢掉缓存重解析一次，别把它当成站点风控降档。
        if (usingCachedTarget) {
          this.forgetTarget()
          const stale = new Error(`HTTP ${response.status}：缓存的重定向地址已失效`)
          stale.code = 'TARGET_STALE'
          throw stale
        }
        throw new Error(describeHttpError(response.status))
      }
      // 416 不是「本段已完成」：远端在说自己没有这个字节范围。早先这里直接 return，
      // 游标不前进、退避计数归零，runChunk 会以每秒几十次的速率空转打远端。
      if (response.status === 416 && pieceEnd >= 0) {
        await response.body?.cancel().catch(() => {})
        const error = new Error('HTTP 416：远端拒绝了该字节范围（文件可能已变化，或被防盗链/CDN 拦截）')
        error.code = 'RANGE_UNSATISFIABLE'
        throw error
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw httpErrorFor(response.status, response)
      }
      /**
       * 软拦截识别：WAF / 登录页会用 200 或 206 回一份 HTML，长度还稳定。
       * 只看状态码与大小的话，7 KB 的拦截页会被改名成 .exe 交付并标成 completed。
       * 判据要两个信号同时成立才算（content-type 是 HTML 且正文以标记开头，
       * 或者正文明确以 <!doctype html / <html 开头）：
       * 有些站点把二进制也标成 text/html，单看响应头会误杀正常下载。
       * 目标本身就是网页时（.html）不能这么判。
       */
      const expectedName = this.filename !== '' ? this.filename : filenameFromUrl(new URL(target.url))
      const contentType = response.headers.get('content-type') ?? ''
      const htmlTarget = isHtmlFilename(expectedName)
      if (pieceEnd >= 0 && response.status === 200) {
        await response.body?.cancel().catch(() => {})
        // 回 200 有两种原因：远端换了版本（If-Range 不匹配），或服务端根本不认 Range。
        // 只有指纹确实变了才按「版本变化」重下；指纹一致或拿不到指纹时按「忽略 Range」
        // 回退单连接——否则一个不支持 Range 的站点会把任务直接判失败。
        const freshEtag = response.headers.get('etag') ?? ''
        const freshModified = response.headers.get('last-modified') ?? ''
        if (ifRange !== '' && this.remoteChanged(freshEtag, freshModified)) {
          this.superseded = true
          this.fingerprintState = 'changed'
          this.fingerprintNote = '下载过程中远端文件已变化，已自动从头重新下载'
          const changed = new Error('远端文件已变化（If-Range 不匹配）')
          changed.code = 'FINGERPRINT_CHANGED'
          throw changed
        }
        const ignored = new Error('服务器忽略了 Range 请求')
        ignored.code = 'RANGE_IGNORED'
        throw ignored
      }
      if (pieceEnd >= 0 && response.status !== 206) throw new Error(`HTTP ${response.status}`)
      /**
       * 206 必须自证「给的是我要的那一段」。只看状态码不看 Content-Range，
       * 会让把整个文件从 0 重发的服务端把错位字节写进文件中间，而收尾的大小校验照样通过。
       * 区间对不上、或者干脆没有 Content-Range 时，退回单连接整段下载：
       * 那条路径从 0 开始读、以大小收尾，内容至少是可验证的。
       */
      if (pieceEnd >= 0) {
        const range = parseContentRange(response.headers.get('content-range'))
        const mismatch = range === null
          || range.start !== position
          || (range.end >= 0 && range.end < range.start)
        if (mismatch) {
          await response.body?.cancel().catch(() => {})
          const error = new Error(range === null
            ? 'HTTP 206 没有给出 Content-Range，无法确认返回的是请求的区间'
            : `HTTP 206 返回区间错位：请求 ${position}-${pieceEnd}，实际 ${range.start}-${range.end}`)
          error.code = 'RANGE_MISMATCH'
          throw error
        }
        // 总长度变了说明远端换了版本（Content-Range 的总长比 ETag 更难被缓存篡改）。
        if (range.total > 0 && this.totalBytes > 0 && range.total !== this.totalBytes) {
          await response.body?.cancel().catch(() => {})
          this.superseded = true
          this.fingerprintState = 'changed'
          this.fingerprintNote = '下载过程中远端文件已变化，已自动从头重新下载'
          const changed = new Error('远端文件已变化（总长度与探测结果不一致）')
          changed.code = 'FINGERPRINT_CHANGED'
          throw changed
        }
      }
      if (response.body === null) throw new Error('响应没有正文')
      const reader = response.body.getReader()
      let cursor = position
      // 严格按请求区间夹紧写入：多出来的字节绝不落盘（否则会覆盖下一个分片的数据）。
      const writeLimit = pieceEnd >= 0
        ? pieceEnd + 1
        : (this.totalBytes > 0 ? this.totalBytes : Number.POSITIVE_INFINITY)
      // 看门狗判定停滞时会 +1；本轮请求发现它变了就主动放弃这条连接，
      // 由 runChunk 立刻用新连接从当前游标续上（不会消耗网络重试预算）。
      const stallEpoch = this.stallEpoch
      for (;;) {
        let step
        try {
          step = await this.readBody(reader)
        } catch (error) {
          // 空闲超时/读流报错：主动取消正文，别把半死连接留在连接池里。
          await reader.cancel().catch(() => {})
          throw error
        }
        const { done, value } = step
        if (!done && this.stallEpoch !== stallEpoch) {
          await reader.cancel().catch(() => {})
          const stalled = new Error('停滞看门狗：换一组连接重试')
          stalled.code = 'STALL_RESET'
          throw stalled
        }
        if (done) break
        if (this.runToken !== run || this.status !== 'downloading' || this.superseded) {
          await reader.cancel().catch(() => {})
          return
        }
        if (this.handle === null) throw new Error('文件句柄已关闭')
        // 首包特征：目标不是网页，却收到一份以 HTML 标记开头的正文 —— 这就是拦截页。
        if (!htmlTarget && chunk.start === 0 && cursor === 0
          && ((isHtmlContentType(contentType) && startsWithMarkup(value)) || startsWithHtml(value))) {
          await reader.cancel().catch(() => {})
          const blocked = new Error('远端返回的正文是 HTML 页面而不是文件内容（可能是 WAF 拦截页或登录页）')
          blocked.code = 'SOFT_BLOCKED'
          throw blocked
        }
        const room = writeLimit - cursor
        if (room <= 0) {
          // 服务端发的比它自己声明的区间还多：丢掉这条连接，别让它污染下一个分片。
          await reader.cancel().catch(() => {})
          const extra = new Error(`远端的正文超出请求区间（${position}-${pieceEnd}），已中止该连接`)
          extra.code = 'RANGE_OVERFLOW'
          throw extra
        }
        const slice = Math.min(value.length, room)
        // 站点聚合限速（风控后按站点生效）+ 全局限速，两者都要过。
        // 都接受 abort：限速到 1 KB/s 时，已取消的任务不能攥着连接槽睡完整个等待。
        if (site !== null) await site.limiter.take(slice, this.abort.signal)
        await this.manager.limiter.take(slice, this.abort.signal)
        // 限速等待可能覆盖了一次 pause/resume：等到真正落地时句柄可能已经属于新一轮，
        // 继续写会把旧轮的字节写进新轮的文件里。
        if (this.runToken !== run || this.status !== 'downloading' || this.handle === null) {
          await reader.cancel().catch(() => {})
          return
        }
        await this.handle.write(value, 0, slice, cursor)
        cursor += slice
        chunk.cursor = cursor - chunk.start
        this.receivedBytes += slice
      }
      if (this.runToken !== run || this.status !== 'downloading') return
      // 单连接整段下载或已读满本段：正常结束；有进展但没读满则回到循环继续要剩余部分。
      if (pieceEnd < 0) {
        // 无 Range 模式没法从中间续传，正文短了只能报错，重试会拼出重复内容。
        if (this.totalBytes > 0 && cursor < this.totalBytes) throw new Error('连接提前结束：远端未发完整文件')
        return
      }
      /**
       * 短包风暴保护：服务端每次只回几十字节、却对每个 Range 请求都回 206 时，
       * 分片循环会一直「有进展」，既不触发重试也不触发超时，用几千个请求慢慢打远端。
       * 连续多次只给一小截就判定它不可用，交给失败处理（并带上可操作的说明）。
       */
      const requested = pieceEnd - position + 1
      const delivered = cursor - position
      if (delivered > 0 && delivered < requested && delivered < SHORT_STREAM_MIN_BYTES) {
        this.shortBursts = (Number(this.shortBursts) || 0) + 1
        if (this.shortBursts >= SHORT_STREAM_LIMIT) {
          const error = new Error(
            `远端对每个 Range 请求只回 ${delivered} 字节（连续 ${this.shortBursts} 次），`
            + '疑似代理/网关没有真正转发区间请求；已停止连续请求，请稍后重试或换镜像',
          )
          error.code = 'SHORT_STREAM'
          throw error
        }
      } else if (delivered > 0) {
        this.shortBursts = 0
      }
      if (cursor > pieceEnd || cursor > position) return
      throw new Error('连接提前结束')
    } finally {
      if (release !== null) release()
    }
  }

  /**
   * 带空闲超时地读一段正文。
   *
   * 服务端可能回了 206 头和几个字节就停住；没有超时的话这个分片会永远停在
   * reader.read() 上：速度归零、不触发重试、而且一直占着全局连接槽。
   */
  async readBody(reader) {
    const idle = this.manager.ioIdleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS
    if (!(idle > 0)) return reader.read()
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`分片正文超时（${Math.round(idle / 1000)} 秒没有收到数据），正在重试`)
        error.name = 'AbortError'
        error.code = 'BODY_IDLE_TIMEOUT'
        reject(error)
      }, idle)
      timer.unref?.()
    })
    try {
      return await Promise.race([reader.read(), timeout])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /**
   * 续传前的指纹复核：旁证、远端大小、ETag、Last-Modified 任一项变化，
   * 都丢弃旧分片从头下载；探测失败时按设置决定降级续传还是明确失败。
   */
  async revalidate() {
    let stale = ''
    const meta = await this.readMeta()
    if (meta !== null) {
      if (this.urls.length === 1 && typeof meta.url === 'string' && meta.url !== '' && meta.url !== this.url) {
        stale = 'url'
      } else {
        const diff = fingerprintChange(
          { size: meta.size, etag: meta.etag, lastModified: meta.lastModified },
          this.currentFingerprint(),
        )
        if (diff !== '') stale = diff
      }
    }
    let fresh
    try {
      fresh = await probe(this.url, this.abort.signal, this.headers, this.dispatcher())
    } catch (error) {
      if (this.abort.signal.aborted) throw error
      if (this.manager.fingerprintResume && this.hasValidator()) {
        throw new Error('无法校验续传指纹：远端探测失败，为避免把不同版本拼进同一个文件，已停止续传')
      }
      this.fingerprintState = 'unverified'
      this.fingerprintNote = '续传前未能复核远端指纹（探测失败），按本地分片继续'
      return
    }
    const reason = fingerprintChange(this.currentFingerprint(), fresh) || stale
    if (reason === '') {
      this.fingerprintState = this.hasValidator() ? 'verified' : ''
      this.fingerprintNote = ''
      this.rememberTarget(this.url, fresh)
      return
    }
    this.fingerprintState = 'changed'
    this.fingerprintNote = reason === 'url'
      ? '分片文件来自另一个地址，已从头重新下载'
      : '远端文件已变化，已丢弃旧分片重新下载'
    this.totalBytes = fresh.size || this.totalBytes
    this.etag = fresh.etag || this.etag
    this.lastModified = fresh.lastModified || this.lastModified
    this.chunks = this.buildChunks(fresh)
    this.receivedBytes = 0
    this.progress = 0
    this.history = []
    this.recent = []
    this.historyStep = 1
    if (this.manager.shouldDisplay(this)) this.history = [{ t: 0, p: 0, s: 0 }]
    this.resetFile = true
  }

  /** 下载途中发现远端文件已变：重新探测并按新版本整段重下（每个任务只重开一次）。 */
  async restartFresh() {
    this.freshRestart = true
    this.superseded = false
    this.closeHandle()
    const result = await this.probeAny()
    this.rememberTarget(this.url, result)
    this.totalBytes = result.size > 0 ? result.size : 0
    if (this.totalBytes <= 0) throw new Error('远端文件已变化，且重新探测未拿到文件大小')
    this.etag = result.etag ?? ''
    this.lastModified = result.lastModified ?? ''
    this.chunks = this.buildChunks(result)
    this.receivedBytes = 0
    this.progress = 0
    this.history = []
    this.recent = []
    this.historyStep = 1
    if (this.manager.shouldDisplay(this)) this.history = [{ t: 0, p: 0, s: 0 }]
    this.resetFile = true
    this.status = 'downloading'
    await this.runChunks()
  }

  /** 服务器中途忽略 Range：丢掉分片，改用单连接整段重下。 */
  async restartSingleStream() {
    this.rangeFallback = true
    this.chunks = [{ start: 0, end: -1, cursor: 0, total: this.totalBytes }]
    this.planThreads = 1
    this.expansions = 0
    this.receivedBytes = 0
    this.progress = 0
    this.history = []
    this.recent = []
    this.historyStep = 1
    if (this.manager.shouldDisplay(this)) this.history = [{ t: 0, p: 0, s: 0 }]
    this.closeHandle()
    this.resetFile = true
    await this.runChunks()
  }

  /**
   * 一轮下载。用令牌标记本轮：pause 后立刻 resume 会开新一轮，旧轮的循环与收尾
   * 发现令牌被换掉就安静退出，不会去 finalize/fail 别人的句柄与状态。
   * 传入 expected 表示由 run() 带着令牌进来：令牌已变（被暂停或换轮）就直接退出，
   * 否则暂停中的任务会被旧 run() 重新激活。
   */
  async runChunks(expected) {
    if (expected !== undefined && this.runToken !== expected) return
    const run = expected ?? Symbol('run')
    this.runToken = run
    try {
      await this.runChunksBody(run)
    } catch (error) {
      if (this.runToken !== run) return
      this.fail(error)
    }
  }

  async runChunksBody(run) {
    this.abort = new AbortController()
    this.superseded = false
    this.status = 'downloading'
    // 续传前核对旁证 / 大小 / ETag / Last-Modified，变化则从头下载，避免拼出混合内容。
    if (this.chunks.some((chunk) => chunk.cursor > 0)) await this.revalidate()
    if (this.runToken !== run || this.status !== 'downloading') return
    if (this.handle === null) {
      this.handle = await open(this.partPath, 'r+').catch(async (error) => {
        if (error?.code !== 'ENOENT') throw error
        // 续传前临时文件已不在（被外部清理或上一轮收尾带走）：游标全部作废，从 0 重来，
        // 而不是把一个 ENOENT 抛成任务失败。
        for (const chunk of this.chunks) chunk.cursor = 0
        this.receivedBytes = 0
        this.progress = 0
        this.resetFile = true
        return open(this.partPath, 'w+')
      })
    }
    if (this.resetFile) {
      const truncateTo = this.chunks.length === 1 && this.chunks[0].end < 0 ? 0 : this.totalBytes
      await this.handle.truncate(truncateTo)
      this.resetFile = false
      await this.writeMeta()
    }
    // 单连接（无 Range）模式无法从中间续传，续传时从头覆盖。
    if (this.chunks.length === 1 && this.chunks[0].end < 0 && this.chunks[0].cursor > 0) {
      await this.handle.truncate(0)
      this.chunks[0].cursor = 0
      this.receivedBytes = 0
      this.progress = 0
    }
    this.status = 'downloading'
    // 续传起点补一个采样，曲线在暂停区间保持水平而不是斜线。
    this.recordHistory(Date.now())
    this.startSampler()
    // 本轮是一个「动态分片池」：起步分片各起一条流，爬升时再把新切出来的分片塞进来。
    const expansion = this.startExpansion(run)
    let failed = null
    try {
      failed = await this.superviseChunks(run)
    } finally {
      expansion.stop()
      this.spawnChunk = null
    }
    // 本轮已被 pause/resume 或重启换掉：旧轮的收尾必须放弃，否则会误判新一轮。
    if (this.runToken !== run) return
    if (this.status !== 'downloading') return
    if (failed !== null) {
      if (failed?.code === 'FINGERPRINT_CHANGED' && !this.freshRestart) {
        await this.restartFresh()
        return
      }
      // 416：远端否认这些字节范围。只重建一次分片，再失败就明确报错。
      if (failed?.code === 'RANGE_UNSATISFIABLE' && !this.rangeRebuild) {
        this.rangeRebuild = true
        await this.restartFresh()
        return
      }
      if (failed?.code === 'RANGE_IGNORED' && !this.rangeFallback) {
        await this.restartSingleStream()
        return
      }
      // 区间不可信或远端只回短包：都说明「分片 + Range」这条路走不通，
      // 退回单连接整段下载（从 0 读到 EOF，大小与指纹都可验证）。
      if ((failed?.code === 'RANGE_MISMATCH' || failed?.code === 'RANGE_OVERFLOW' || failed?.code === 'SHORT_STREAM')
        && !this.rangeFallback) {
        await this.restartSingleStream()
        return
      }
      this.fail(failed)
      return
    }
    await this.finalize(run)
  }

  /**
   * 跑完本轮的全部分片。语义和原来的 Promise.allSettled 一致（返回第一个失败原因），
   * 区别是分片集合可以在运行中被爬升追加：新分片会立刻起一条流，并计入活跃计数，
   * 直到所有分片（含后来加入的）都结束才返回。
   */
  async superviseChunks(run) {
    let active = 0
    let failure = null
    let idle = null
    const spawn = (chunk) => {
      active += 1
      chunk.running = true
      this.runChunk(chunk, run).then(
        () => undefined,
        (error) => {
          if (failure === null) {
            failure = error
            // 首个致命失败立刻停掉其它分片：否则剩下的连接会陪着一个已经没救的分片
            // 把整个文件跑完（实测一个分片 404 后，任务还在另一条连接上多跑了 4 秒）。
            // 需要重启整轮的失败码除外——它们由收尾逻辑接管，abort 反而会让重启当场失败。
            const restartable = ['FINGERPRINT_CHANGED', 'RANGE_MISMATCH', 'RANGE_OVERFLOW', 'SHORT_STREAM',
              'RANGE_UNSATISFIABLE', 'RANGE_IGNORED'].includes(error?.code)
            if (!restartable && this.status === 'downloading') {
              try {
                this.abort.abort()
              } catch {
                // 已经 abort 过：没有副作用。
              }
            }
          }
        },
      ).finally(() => {
        chunk.running = false
        active -= 1
        // 一条连接刚交还：立刻把还长的剩余区间分一段给它接着跑，比等下一次定时复核快得多。
        // 必须在 active === 0 的判定之前：扩容会把 active 加回去，不能让监督循环误判收尾。
        try {
          if (this.status === 'downloading' && this.runToken === run) this.maybeEscalate()
        } catch {
          // 扩容是优化项：这里出任何问题都不该影响收尾。
        }
        if (active === 0 && idle !== null) {
          const resume = idle
          idle = null
          resume()
        }
      })
    }
    this.spawnChunk = spawn
    for (const chunk of this.chunks) spawn(chunk)
    if (active > 0) {
      await new Promise((resolve) => {
        idle = resolve
        if (active === 0) resolve()
      })
    }
    this.spawnChunk = null
    return failure
  }

  /** 收尾复核：下载期间远端若被替换（未触发 If-Range 的服务器），拒绝交付混合文件。 */
  async verifyFinalFingerprint() {
    if (!this.manager.fingerprintResume || !this.hasValidator()) return
    let fresh
    try {
      // 直接查缓存的最终地址：既省一次 302 往返，也避免再吃一次 GitHub API 配额。
      const target = await this.remoteTarget()
      fresh = await probe(target.url, this.abort.signal, target.headers, this.dispatcher())
    } catch {
      this.fingerprintState = 'unverified'
      this.fingerprintNote = '完成前未能复核远端指纹（探测失败），文件按已下载字节交付'
      return
    }
    const reason = fingerprintChange(this.currentFingerprint(), fresh)
    if (reason !== '') {
      this.fingerprintState = 'changed'
      this.fingerprintNote = '远端文件在下载过程中已变化，已拒绝交付'
      throw new Error(`远端文件在下载过程中已变化（${reason}），已拒绝交付；请重新下载`)
    }
    this.fingerprintState = 'verified'
  }

  /**
   * 收尾。从头到尾都要复查令牌与状态：收尾里的每一步都要等 IO
   * （stat、收尾探测、校验和、rename），期间用户完全可能 pause/cancel。
   * 不复查的话，一个在 checksum 期间被暂停的任务最后会被写成 completed。
   */
  async finalize(run) {
    const stale = () => (run !== undefined && this.runToken !== run) || this.status !== 'downloading'
    if (this.handle === null) throw new Error('文件句柄已关闭')
    const info = await this.handle.stat()
    if (stale()) return
    await this.handle.close()
    this.handle = null
    if (stale()) return
    if (this.totalBytes > 0 && info.size !== this.totalBytes) {
      throw new Error(`文件大小不符：期望 ${this.totalBytes}，实际 ${info.size}`)
    }
    await this.verifyFinalFingerprint()
    if (stale()) return
    if (this.checksum !== null) {
      const spec = CHECKSUM_ALGORITHMS[this.checksum.algorithm]
      const actual = await fileChecksum(this.partPath, this.checksum.algorithm)
      if (stale()) return
      if (actual !== this.checksum.value) {
        throw new Error(`${spec?.label ?? this.checksum.algorithm} 不匹配：期望 ${this.checksum.value}，实际 ${actual}`)
      }
    }
    await rename(this.partPath, this.path)
    this.manager.releaseName(this.path)
    await this.removeMeta()
    this.totalBytes = info.size
    this.receivedBytes = info.size
    this.progress = 1
    this.status = 'completed'
    this.finishedAt = Date.now()
    this.stopSampler()
    if (this.manager.shouldDisplay(this)) {
      const elapsed = Math.max(1, Math.floor((this.finishedAt - this.startedAt) / 1000))
      const last = this.recent.length > 0 ? this.recent[this.recent.length - 1] : this.history[this.history.length - 1]
      if (last === undefined || last.t < elapsed) this.recent.push({ t: elapsed, p: 1, s: 0 })
      else if (this.recent.length > 0) this.recent[this.recent.length - 1] = { ...last, p: 1, s: 0 }
      else this.history[this.history.length - 1] = { ...last, p: 1, s: 0 }
    }
    this.manager.persistTasks()
    this.manager.pump()
  }

  fail(error) {
    if (this.status === 'paused' || this.status === 'canceled' || this.status === 'completed') return
    this.status = 'failed'
    this.error = error instanceof Error ? error.message : String(error)
    this.stopSampler()
    this.abort.abort()
    this.closeHandle()
    this.manager.persistTasks()
    this.manager.pump()
  }

  closeHandle() {
    const handle = this.handle
    this.handle = null
    if (handle !== null) handle.close().catch(() => {})
  }

  pause() {
    // 排队中的任务直接从队列里停下，否则「暂停成功」之后它照样会开始下载。
    if (this.status === 'queued') {
      this.status = 'paused'
      this.manager.persistTasks()
      this.manager.pump()
      return
    }
    if (!this.active) return
    // 作废本轮令牌：旧的分片循环与收尾看到令牌变了就退出，不会再碰句柄。
    this.runToken = null
    this.status = 'paused'
    this.recordHistory(Date.now())
    this.stopSampler()
    this.abort.abort()
    this.closeHandle()
    this.manager.persistTasks()
    this.manager.pump()
  }

  resume() {
    if (this.status === 'paused') {
      this.error = ''
      if (this.chunks.length === 0 || this.partPath === '') {
        this.status = 'probing'
        this.run().catch((error) => this.fail(error))
        return
      }
      this.status = 'downloading'
      this.startedAt = this.startedAt || Date.now()
      this.runChunks().catch((error) => this.fail(error))
      return
    }
    if (this.status === 'failed') {
      this.error = ''
      if (this.path === '' || this.chunks.length === 0) {
        this.status = 'queued'
        this.begin()
        return
      }
      this.status = 'downloading'
      void (async () => {
        try {
          // 临时文件可能已被 cancel/remove 或上一轮收尾清掉：这时没有可续传的字节，
          // 退回去重新探测、从头下载，而不是把一个 ENOENT 记成任务失败。
          const handle = await open(this.partPath, 'r+').catch((error) => {
            if (error?.code === 'ENOENT') return null
            throw error
          })
          if (handle === null) {
            this.chunks = []
            this.status = 'probing'
            await this.run()
            return
          }
          await handle.truncate(this.totalBytes)
          await handle.close()
          /**
           * 失败后重试沿用已下载的游标：临时文件是位置写入的，已完成的字节仍然有效，
           * 从头重下等于把几个小时都丢掉。真正需要归零的只有「无 Range 单流」那条路径
           * ——它的正文总是从 0 开始，游标失去意义。
           */
          if (this.chunks.some((chunk) => chunk.end < 0)) {
            this.chunks = this.chunks.map((chunk) => ({ ...chunk, cursor: 0 }))
            this.receivedBytes = 0
          } else {
            this.receivedBytes = this.chunks.reduce((sum, chunk) => sum + (Number(chunk.cursor) || 0), 0)
          }
          // 失败遗留的「极慢/已换过连接」标记要清掉，否则看门狗在重试里永久失效。
          this.stallResets = 0
          this.stallSlow = false
          this.stallNote = ''
          this.stallWindowAt = 0
          this.stallWindowBytes = 0
          await this.runChunks()
        } catch (error) {
          this.fail(error)
        }
      })()
    }
  }

  async cancel() {
    if (this.status === 'completed' || this.status === 'canceled') return
    this.status = 'canceled'
    this.stopSampler()
    this.abort.abort()
    this.closeHandle()
    if (this.partPath !== '') await unlink(this.partPath).catch(() => {})
    await this.removeMeta()
    this.manager.releaseName(this.path)
    this.manager.persistTasks()
    this.manager.pump()
  }

  async remove() {
    await this.cancel()
    this.closeHandle()
    if (this.partPath !== '') await unlink(this.partPath).catch(() => {})
    await this.removeMeta()
    this.manager.tasks.delete(this.id)
    this.manager.persistTasks()
    this.manager.pump()
  }

  dispose() {
    this.stopSampler()
    this.abort.abort()
    this.closeHandle()
  }
}

/** 下载任务管理器：唯一的操作入口，路由与工具共用。 */
class Downloader {
  constructor(options) {
    this.root = options.directory
    this.defaultThreads = options.threads
    this.maxConnections = clampConnections(options.maxConnections)
    this.slots = new ConnectionSlots(this.maxConnections)
    this.maxConcurrent = Math.max(1, Math.min(MAX_ACTIVE_TASKS, this.maxConnections))
    /** 设备负载自适应：高负载时把实际连接预算压低，Agent 也绕不过。 */
    this.loadAdaptive = options.loadAdaptive !== false
    this.loadGovernor = new LoadGovernor(this.maxConnections, this.loadAdaptive)
    this.resourceSampler = new ResourceSampler((sample) => this.applyResourceSample(sample))
    if (this.loadAdaptive) this.resourceSampler.start()
    /** 站点风控自适应：每个站点一套独立并发与限速。 */
    this.siteAdaptive = options.siteAdaptive !== false
    this.siteGovernor = new SiteGovernor(this.siteAdaptive)
    this.largeFileBytes = options.largeFileMb * 1024 * 1024
    this.largeFileMb = Math.round(this.largeFileBytes / (1024 * 1024))
    this.minThreadMb = options.minThreadMb
    this.minThreadBytes = options.minThreadMb * 1024 * 1024
    this.settingsPath = options.settingsPath
    this.settingsPersistError = ''
    this.minThreadEnabled = options.minThreadEnabled
    this.agentAutonomy = options.agentAutonomy
    this.autoThreads = options.autoThreads !== false
    this.fingerprintResume = options.fingerprintResume !== false
    this.silentEnabled = options.silentEnabled
    this.rateLimitBytes = options.rateLimitBytes ?? 0
    this.limiter = new RateLimiter(this.rateLimitBytes)
    /** 分片正文空闲超时（毫秒）；测试可传小值，生产用默认 30 秒。 */
    this.ioIdleTimeoutMs = Number(options.ioIdleTimeoutMs) > 0 ? Number(options.ioIdleTimeoutMs) : BODY_IDLE_TIMEOUT_MS
    /**
     * 停滞看门狗：窗口内吞吐低于下限就换一组连接。默认开启；关掉后只剩
     * 「正文空闲超时」这一层，涓流连接会一直挂着。测试可把窗口压到几百毫秒。
     */
    this.stallWatchdog = options.stallWatchdog !== false
    this.stallWindowMs = Number(options.stallWindowMs) > 0 ? Number(options.stallWindowMs) : STALL_WINDOW_MS
    this.stallWindowSec = Math.max(1, Math.round(this.stallWindowMs / 1000))
    this.stallMinBytes = Number(options.stallMinBytes) > 0 ? Number(options.stallMinBytes) : STALL_MIN_BYTES
    this.stallMaxResets = Number.isFinite(Number(options.stallMaxResets)) && Number(options.stallMaxResets) >= 0
      ? Math.round(Number(options.stallMaxResets))
      : STALL_MAX_RESETS
    this.dohEnabled = options.dohEnabled === true
    this.dohProvider = normalizeDohProvider(options.dohProvider)
    this.githubEnabled = options.githubEnabled === true
    this.dohAgents = new Map()
    this.tasks = new Map()
    this.reservedNames = new Set()
    this.nameQueue = Promise.resolve()
    this.tasksPath = options.tasksPath
    this.restoreTasks()
    this.persistTimer = setInterval(() => this.persistTasks(), 5000)
    this.persistTimer.unref?.()
  }

  /**
   * 任务是否进入 UI：
   * - 用户手动下载（面板 URL/目录/线程）始终显示；
   * - Agent 发起的下载按静默阈值判断。
   */
  shouldDisplay(task) {
    if (task.forceDisplay === true) return true
    if (task.origin === 'user') return true
    return !this.silentEnabled || task.totalBytes >= this.largeFileBytes
  }

  /** 串行分配文件名并登记占用，避免并发任务选中同一个名字。 */
  async reserveName(dir, base) {
    const operation = this.nameQueue.then(async () => {
      const name = await uniqueName(dir, base, this.reservedNames)
      this.reservedNames.add(join(dir, name))
      return name
    })
    this.nameQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  releaseName(path) {
    if (typeof path === 'string' && path !== '') this.reservedNames.delete(path)
  }

  activeCount() {
    let count = 0
    for (const task of this.tasks.values()) if (task.active) count += 1
    return count
  }

  /** 当前实际生效的连接预算（设备高负载时低于用户设定值）。 */
  get effectiveConnections() {
    return this.slots.limit
  }

  /** 采样回调：压力高收缩、压力低逐步恢复，空闲时回到用户设定值。 */
  applyResourceSample(sample) {
    this.lastResources = sample
    const limit = this.loadGovernor.observe(sample.cpuPct, sample.memoryPct, {
      // 没有连接在跑时收缩没有意义：下一次任务会带着被压低的预算起步，
      // 低配机器上就表现为「上限 5，实际一直 1 条连接」。
      active: this.slots.used > 0,
      freeBytes: sample.freeBytes,
      now: sample.takenAt,
    })
    this.applyConnectionBudget(limit)
  }

  applyConnectionBudget(limit) {
    const next = Math.max(1, Math.round(limit) || 1)
    if (this.slots.limit !== next) this.slots.setLimit(next)
    this.maxConcurrent = Math.max(1, Math.min(MAX_ACTIVE_TASKS, next))
    this.pump()
  }

  setLoadAdaptive(enabled) {
    this.loadAdaptive = enabled !== false
    const limit = this.loadGovernor.setEnabled(this.loadAdaptive)
    if (this.loadAdaptive) this.resourceSampler.start()
    else this.resourceSampler.stop()
    this.applyConnectionBudget(limit)
  }

  setSiteAdaptive(enabled) {
    this.siteAdaptive = enabled !== false
    this.siteGovernor.setEnabled(this.siteAdaptive)
  }

  resourceState() {
    const governor = this.loadGovernor
    return {
      enabled: this.loadAdaptive,
      cpuPct: governor.cpuPct === null ? null : Math.round(governor.cpuPct),
      memoryPct: governor.memoryPct === null ? null : Math.round(governor.memoryPct),
      memoryPressure: Math.round(governor.memoryPressure ?? 0),
      pressure: governor.pressure === null ? null : Math.round(governor.pressure),
      level: governor.level,
      baseConnections: governor.base,
      effectiveConnections: governor.limit,
      sampledAt: governor.lastSampleAt,
    }
  }

  /** 未结束的任务数：排队/解析/下载/暂停；不含完成、取消与失败。 */
  unfinishedCount() {
    let count = 0
    for (const task of this.tasks.values()) {
      if (task.status === 'queued' || task.status === 'probing' || task.status === 'downloading' || task.status === 'paused') count += 1
    }
    return count
  }

  /**
   * 侧边栏徽标与对话进度条共用的汇总：未完成任务数、聚合进度、总速度，
   * 以及一个代表任务（优先取正在下载的那个）。
   */
  summary() {
    let unfinished = 0
    let totalBytes = 0
    let receivedBytes = 0
    let speed = 0
    let etaSpeed = 0
    let downloadingRemaining = 0
    let top = null
    const tasks = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'queued' && task.status !== 'probing' && task.status !== 'downloading' && task.status !== 'paused') continue
      if (!this.shouldDisplay(task)) continue
      const remainingBytes = task.totalBytes > 0 ? Math.max(0, task.totalBytes - task.receivedBytes) : 0
      const rate = task.etaSpeed > 0 ? task.etaSpeed : task.speed
      const entry = {
        id: task.id,
        filename: task.filename,
        url: task.url,
        status: task.status,
        progress: task.totalBytes > 0 ? Math.min(1, task.receivedBytes / task.totalBytes) : 0,
        speed: task.speed,
        totalBytes: task.totalBytes,
        receivedBytes: task.receivedBytes,
        remainingBytes,
        ...(task.status === 'downloading' && rate >= SLOW_SPEED_BPS && remainingBytes > 0
          ? { etaSeconds: Math.max(1, Math.round(remainingBytes / rate)) }
          : {}),
      }
      tasks.push(entry)
      unfinished += 1
      totalBytes += task.totalBytes
      receivedBytes += task.receivedBytes
      if (task.status === 'downloading') {
        speed += task.speed
        etaSpeed += rate
        downloadingRemaining += remainingBytes
      }
      if (top === null || (top.status !== 'downloading' && task.status === 'downloading')) top = entry
    }
    // 聚合 ETA 用平滑速度：面板与输入框上方的进度条每秒刷新一次，瞬时速度会让「约剩」乱跳。
    const etaSeconds = etaSpeed >= SLOW_SPEED_BPS && downloadingRemaining > 0 ? Math.max(1, Math.round(downloadingRemaining / etaSpeed)) : null
    return { unfinished, active: this.activeCount(), activeConnections: this.slots.used, maxConnections: this.maxConnections, effectiveConnections: this.effectiveConnections, loadLevel: this.loadGovernor.level, siteThrottles: this.siteGovernor.snapshot().length, totalBytes, receivedBytes, speed, ...(etaSeconds === null ? {} : { etaSeconds }), top, tasks, largeFileBytes: this.largeFileBytes, largeFileMb: this.largeFileMb, minThreadBytes: this.minThreadBytes, minThreadMb: this.minThreadMb, minThreadEnabled: this.minThreadEnabled, agentAutonomy: this.agentAutonomy, autoThreads: this.autoThreads, fingerprintResume: this.fingerprintResume, silentEnabled: this.silentEnabled }
  }

  /** 一次校验并应用两个阈值，避免部分成功。 */
  applySettings(input) {
    const bytes = input.largeFileBytes !== undefined
      ? Math.round(Number(input.largeFileBytes))
      : input.largeFileMb !== undefined
        ? Math.round(Number(input.largeFileMb)) * 1024 * 1024
        : this.largeFileBytes
    const minThreadBytes = input.minThreadBytes !== undefined
      ? Math.round(Number(input.minThreadBytes))
      : input.minThreadMb !== undefined
        ? Math.round(Number(input.minThreadMb)) * 1024 * 1024
        : this.minThreadBytes
    if (!Number.isFinite(bytes) || bytes < 1024 || bytes > 10 * 1024 * 1024 * 1024) {
      throw new Error('静默阈值需为 1 KB..10 GB')
    }
    if (!Number.isFinite(minThreadBytes) || minThreadBytes < 0 || minThreadBytes > 10 * 1024 * 1024 * 1024) {
      throw new Error('单线程阈值需为 0..10 GB')
    }
    /**
     * 先把后面几个还要校验的字段全部验证完，再开始改内存状态。
     * 否则「静默阈值已生效、并发数报错」会留下一个半生效的设置：
     * 面板显示新值、磁盘里还是旧值，刷新后又跳回去。
     */
    const rate = input.rateLimitBytes === undefined ? null : Math.round(Number(input.rateLimitBytes))
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1024 * 1024 * 1024)) {
      throw new Error('限速需为 0..1 GB/s')
    }
    const concurrency = input.maxConnections === undefined ? null : Math.round(Number(input.maxConnections))
    if (concurrency !== null && (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > MAX_CONNECTIONS)) {
      throw new Error(`并发限制数需为 1..${MAX_CONNECTIONS}`)
    }
    const stallSeconds = input.stallWindowSec === undefined ? null : Math.round(Number(input.stallWindowSec))
    if (stallSeconds !== null && (!Number.isFinite(stallSeconds) || stallSeconds < 10 || stallSeconds > 600)) {
      throw new Error('停滞判定窗口需为 10..600 秒')
    }
    this.largeFileBytes = bytes
    this.largeFileMb = Math.round(bytes / (1024 * 1024))
    this.minThreadBytes = minThreadBytes
    this.minThreadMb = Math.round(minThreadBytes / (1024 * 1024))
    if (input.minThreadEnabled !== undefined) this.minThreadEnabled = Boolean(input.minThreadEnabled)
    if (input.agentAutonomy !== undefined) this.agentAutonomy = Boolean(input.agentAutonomy)
    if (input.autoThreads !== undefined) this.autoThreads = Boolean(input.autoThreads)
    if (input.fingerprintResume !== undefined) this.fingerprintResume = Boolean(input.fingerprintResume)
    if (input.silentEnabled !== undefined) this.silentEnabled = Boolean(input.silentEnabled)
    if (rate !== null) {
      this.rateLimitBytes = rate
      this.limiter.setRate(rate)
    }
    if (concurrency !== null) {
      this.maxConnections = concurrency
      // 用户设定的是上限；实际预算仍由设备负载决定。
      this.applyConnectionBudget(this.loadGovernor.setBase(concurrency))
    }
    if (input.loadAdaptive !== undefined) this.setLoadAdaptive(Boolean(input.loadAdaptive))
    if (input.siteAdaptive !== undefined) this.setSiteAdaptive(Boolean(input.siteAdaptive))
    if (input.dohEnabled !== undefined || input.dohProvider !== undefined) {
      this.setDoh(
        input.dohEnabled !== undefined ? Boolean(input.dohEnabled) : this.dohEnabled,
        input.dohProvider !== undefined ? input.dohProvider : this.dohProvider,
      )
    }
    if (input.githubEnabled !== undefined) this.githubEnabled = Boolean(input.githubEnabled)
    if (input.stallWatchdog !== undefined) this.stallWatchdog = Boolean(input.stallWatchdog)
    if (stallSeconds !== null) {
      this.stallWindowSec = stallSeconds
      this.stallWindowMs = stallSeconds * 1000
    }
    const persisted = this.persistSettings()
    return {
      largeFileBytes: bytes,
      largeFileMb: this.largeFileMb,
      minThreadBytes,
      minThreadMb: this.minThreadMb,
      minThreadEnabled: this.minThreadEnabled,
      agentAutonomy: this.agentAutonomy,
      autoThreads: this.autoThreads,
      fingerprintResume: this.fingerprintResume,
      silentEnabled: this.silentEnabled,
      rateLimitBytes: this.rateLimitBytes,
      maxConnections: this.maxConnections,
      loadAdaptive: this.loadAdaptive,
      siteAdaptive: this.siteAdaptive,
      effectiveConnections: this.effectiveConnections,
      dohEnabled: this.dohEnabled,
      dohProvider: this.dohProvider,
      githubEnabled: this.githubEnabled,
      stallWatchdog: this.stallWatchdog,
      stallWindowSec: this.stallWindowSec,
      persisted,
      ...this.settingsPersistError === '' ? {} : { persistError: this.settingsPersistError },
    }
  }

  /** 把当前阈值写回 profile 下的本地文件；失败只记录原因，不影响内存设置。 */
  persistSettings() {
    if (typeof this.settingsPath !== 'string' || this.settingsPath === '') return false
    try {
      const payload = JSON.stringify({
        version: SETTINGS_SCHEMA_VERSION,
        largeFileBytes: this.largeFileBytes,
        minThreadBytes: this.minThreadBytes,
        minThreadEnabled: this.minThreadEnabled,
        agentAutonomy: this.agentAutonomy,
        autoThreads: this.autoThreads,
        fingerprintResume: this.fingerprintResume,
        silentEnabled: this.silentEnabled,
        rateLimitBytes: this.rateLimitBytes,
        maxConnections: this.maxConnections,
        loadAdaptive: this.loadAdaptive,
        siteAdaptive: this.siteAdaptive,
        dohEnabled: this.dohEnabled,
        dohProvider: this.dohProvider,
        githubEnabled: this.githubEnabled,
        stallWatchdog: this.stallWatchdog,
        stallWindowSec: this.stallWindowSec,
      }, null, 2)
      const temporary = `${this.settingsPath}.tmp`
      writeFileSync(temporary, payload)
      renameSync(temporary, this.settingsPath)
      this.settingsPersistError = ''
      return true
    } catch (error) {
      this.settingsPersistError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  pump() {
    if (this.activeCount() >= this.maxConcurrent) return
    for (const task of this.tasks.values()) {
      if (this.activeCount() >= this.maxConcurrent) return
      if (task.status === 'queued') task.begin()
    }
  }

  /** 把未完成任务写入 profile，插件重载/DSH 重启后可恢复为暂停状态。 */
  persistTasks() {
    if (typeof this.tasksPath !== 'string' || this.tasksPath === '') return false
    try {
      const records = []
      for (const task of this.tasks.values()) {
        if (task.partPath === '' || !['queued', 'probing', 'downloading', 'paused'].includes(task.status)) continue
        if (task.totalBytes <= 0) continue
        records.push(task.toRecord())
      }
      const temporary = `${this.tasksPath}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, tasks: records }, null, 2))
      renameSync(temporary, this.tasksPath)
      return true
    } catch {
      return false
    }
  }

  /** 启动时恢复暂停任务；分片文件不存在或记录损坏时跳过。 */
  restoreTasks() {
    if (typeof this.tasksPath !== 'string' || this.tasksPath === '') return
    let data
    try {
      data = JSON.parse(readFileSync(this.tasksPath, 'utf8'))
    } catch {
      return
    }
    const records = Array.isArray(data?.tasks) ? data.tasks : []
    for (const record of records) {
      try {
        if (typeof record?.id !== 'string' || !Array.isArray(record.urls) || record.urls.length === 0) continue
        if (typeof record.partPath !== 'string' || !existsSync(record.partPath)) continue
        const task = new DownloadTask(this, {
          id: record.id,
          urls: record.urls,
          dir: record.dir,
          filename: record.filename,
          threads: record.threads ?? this.defaultThreads,
          singleThread: record.singleThread,
          origin: record.origin,
          headers: record.headers ?? {},
          doh: record.doh === true,
          dohProvider: record.dohProvider ?? this.dohProvider,
          github: record.github === true,
          forceDisplay: record.forceDisplay === true,
          checksum: record.checksum ?? (typeof record.sha256 === 'string' && record.sha256 !== '' ? { algorithm: 'sha256', value: record.sha256 } : null),
        })
        task.requestedName = typeof record.requestedName === 'string' ? record.requestedName : ''
        task.threadsExplicit = record.threadsExplicit === true
        task.path = record.path
        task.partPath = record.partPath
        task.totalBytes = Number(record.totalBytes) || 0
        task.etag = record.etag ?? ''
        task.lastModified = record.lastModified ?? ''
        task.createdAt = Number(record.createdAt) || Date.now()
        task.chunks = Array.isArray(record.chunks) ? record.chunks : []
        // 续传时沿用原来的起步分片数，否则一个「显式 2 线程」的任务恢复后会被当成自动阶梯爬到 8。
        task.planThreads = Number(record.planThreads) || task.chunks.length
        task.receivedBytes = task.chunks.reduce((sum, chunk) => sum + (Number(chunk.cursor) || 0), 0)
        task.progress = task.totalBytes > 0 ? Math.min(1, task.receivedBytes / task.totalBytes) : 0
        task.status = 'paused'
        this.tasks.set(task.id, task)
        this.reservedNames.add(task.path)
      } catch {
        // 单条记录损坏不影响其它任务。
      }
    }
  }

  list(detailed = false) {
    return [...this.tasks.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((task) => task.snapshot(detailed ? { history: true } : {}))
  }

  get(id) {
    const task = this.tasks.get(id)
    if (task === undefined) throw new Error(`下载任务不存在：${id}`)
    return task
  }

  dohAgent(provider) {
    const key = normalizeDohProvider(provider)
    let agent = this.dohAgents.get(key)
    if (agent === undefined) {
      agent = createDohDispatcher(key)
      this.dohAgents.set(key, agent)
    }
    return agent
  }

  setDoh(enabled, provider) {
    const nextProvider = normalizeDohProvider(provider ?? this.dohProvider)
    if (this.dohEnabled === enabled && this.dohProvider === nextProvider) return
    this.dohEnabled = enabled
    this.dohProvider = nextProvider
    for (const agent of this.dohAgents.values()) agent.close?.()
    this.dohAgents.clear()
  }

  async add(request) {
    if (this.tasks.size >= MAX_TASKS) throw new Error(`任务数已达上限 ${MAX_TASKS}，请先移除旧任务`)
    const urls = []
    const candidates = Array.isArray(request.urls) && request.urls.length > 0 ? request.urls : [request.url]
    if (Array.isArray(request.mirrors)) candidates.push(...request.mirrors)
    for (const candidate of candidates) {
      const parsed = parseHttpUrl(candidate)
      if (!urls.includes(parsed.toString())) urls.push(parsed.toString())
    }
    const checksum = normalizeChecksum(request)
    const doh = request.doh === undefined ? this.dohEnabled : Boolean(request.doh)
    const dohProvider = normalizeDohProvider(request.dohProvider ?? this.dohProvider)
    let headers = sanitizeHeaders(request.headers)
    let sourceUrl = urls[0]
    const github = request.github === undefined ? this.githubEnabled : Boolean(request.github)
    if (github) {
      const resolved = await resolveGithubAsset(urls[0])
      if (resolved !== null) {
        urls[0] = resolved.url
        headers = { ...headers, ...resolved.headers }
      }
    }
    const directory = typeof request.directory === 'string' && request.directory.trim() !== ''
      ? resolve(request.directory.trim())
      : this.root
    await mkdir(directory, { recursive: true })
    const task = new DownloadTask(this, {
      id: randomUUID().slice(0, 8),
      urls,
      dir: directory,
      filename: sanitizeFilename(request.filename ?? ''),
      threads: numberConfig(request.threads, this.defaultThreads, 1, MAX_THREADS),
      threadsExplicit: request.threads !== undefined && request.threads !== null,
      singleThread: request.singleThread === undefined ? undefined : Boolean(request.singleThread),
      origin: request.origin === 'user' ? 'user' : 'agent',
      headers,
      checksum,
      doh,
      dohProvider,
      github,
      forceDisplay: request.forceDisplay === true,
      sourceUrl,
    })
    this.tasks.set(task.id, task)
    this.persistTasks()
    this.pump()
    return task.snapshot()
  }

  async control(id, action) {
    const task = this.get(id)
    switch (action) {
      case 'pause':
        // 已结束或已暂停：状态不变，仍然返回当前任务，便于 Agent 确认。
        if (task.status === 'completed' || task.status === 'canceled' || task.status === 'paused') {
          return { task: task.snapshot() }
        }
        task.pause()
        return { task: task.snapshot() }
      case 'resume':
        if (task.status === 'canceled') throw new Error('任务已取消，无法恢复；请重新新建下载')
        if (task.status === 'completed') throw new Error('任务已完成，无需恢复')
        if (task.status === 'queued' || task.active) return { task: task.snapshot() }
        task.resume()
        this.pump()
        return { task: task.snapshot() }
      case 'cancel':
        await task.cancel()
        return { task: task.snapshot() }
      case 'remove':
        await task.remove()
        return { removed: id }
      default:
        throw new Error(`未知操作：${action}`)
    }
  }

  clean() {
    const finished = ['completed', 'failed', 'canceled']
    let removed = 0
    for (const task of [...this.tasks.values()]) {
      if (!finished.includes(task.status)) continue
      // 释放文件名占位，否则同名文件下次下载会被迫改名为 "xxx (1).bin"。
      if (task.path !== '') this.releaseName(task.path)
      this.tasks.delete(task.id)
      removed += 1
    }
    this.persistTasks()
    return removed
  }

  dispose() {
    this.persistTasks()
    if (this.persistTimer !== null) clearInterval(this.persistTimer)
    this.resourceSampler.stop()
    for (const task of this.tasks.values()) task.dispose()
    this.tasks.clear()
    // DoH 的 undici Agent 持有 keep-alive 连接池，插件重载前必须关掉。
    for (const agent of this.dohAgents.values()) agent.close?.()
    this.dohAgents.clear()
  }
}

/** 本机浏览器同源请求判定（不依赖 Cookie，避免桌面壳无 Cookie 时误拒）。 */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isLoopbackAddress(normalized.slice(7))
  const parts = normalized.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isLoopbackAddress(hostname.replace(/^\[|\]$/g, ''))
}

function isTrustedRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  if (request.headers['x-forwarded-for'] !== undefined || request.headers['cf-connecting-ip'] !== undefined) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  // 浏览器同源标记优先：页面可能用 localhost 打开而 Host 是 127.0.0.1。
  if (request.headers['sec-fetch-site'] === 'same-origin') return true
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(response, status, body) {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body))
}

async function readJsonBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  return JSON.parse(raw)
}

function toolText(value) {
  return [{ type: 'text', text: value }]
}

/** 工具参数：一个 action 覆盖全部操作。 */
const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'list', 'pause', 'resume', 'cancel', 'remove', 'clean'],
      description: 'add 新建下载；list 查看任务；pause/resume/cancel/remove 控制指定 id；clean 清空已结束任务。',
    },
    url: { type: 'string', description: 'add 时的 http/https 下载地址；批量下载用 urls。' },
    urls: { type: 'array', items: { type: 'string' }, description: '批量下载地址（最多 20 个），与 url 二选一。' },
    mirrors: { type: 'array', items: { type: 'string' }, description: '备用镜像地址；主地址失败或分片出错时轮换重试。' },
    headers: { type: 'object', additionalProperties: { type: 'string' }, description: '自定义请求头，如 Cookie / Referer / Authorization；禁止 Range 等下载器控制的头。' },
    sha256: { type: 'string', description: '兼容旧参数：完成后校验的 SHA-256（64 位十六进制）。新代码请用 checksum。' },
    checksum: {
      type: 'object',
      additionalProperties: false,
      properties: {
        algorithm: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha512', 'crc32'] },
        value: { type: 'string', description: '十六进制校验值；长度随算法变化。' },
      },
      required: ['algorithm', 'value'],
      description: '完成后校验文件；支持 md5/sha1/sha256/sha512/crc32。',
    },
    id: { type: 'string', description: 'pause/resume/cancel/remove 时的任务 id；list 时只返回该任务。' },
    directory: { type: 'string', description: '保存目录，省略则用插件默认目录。' },
    filename: { type: 'string', description: '保存文件名，省略则由响应头或 URL 推断。' },
    doh: { type: 'boolean', description: 'add 时让该任务用 DoH 解析域名（本机 DNS 可能被污染时用）；省略则跟随插件设置。' },
    dohProvider: {
      type: 'string',
      enum: ['cloudflare', 'alidns', 'tencent'],
      description: 'add 时的 DoH 提供商；省略则跟随插件设置（默认阿里 DoH）。',
    },
    github: { type: 'boolean', description: 'add 时把 GitHub Release 直链换成 API 资产链接（受未认证 API 60 次/小时限制）；省略则跟随插件设置，失败会回退直链。' },
    forceDisplay: { type: 'boolean', description: 'add 时强制在面板和对话显示该任务，即使小于静默阈值。' },
    threads: { type: 'integer', description: '分片并发数 1..16；所有任务共享并发限制数（默认 16，= 任务数 × 线程数），超出部分排队，Agent 无法绕过该上限。' },
    singleThread: { type: 'boolean', description: 'true 强制单连接，false 强制分片；省略时普通模式按单线程阈值，Agent 自主模式下默认分片。' },
    limit: { type: 'integer', description: 'list 时最多返回多少条（1..100，默认 20）。' },
    waitSeconds: { type: 'integer', minimum: 0, maximum: 300, description: 'list 时最多等多少秒：期间每秒检查一次，任务全部结束或超时后返回，避免反复轮询。默认 0（立即返回）。' },
  },
  required: ['action'],
}

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    dir: { type: 'string' },
    filename: { type: 'string' },
    path: { type: 'string' },
    status: { type: 'string' },
    error: { type: 'string' },
    totalBytes: { type: 'integer' },
    receivedBytes: { type: 'integer' },
    remainingBytes: { type: 'integer' },
    progress: { type: 'number' },
    speed: { type: 'integer' },
    etaSeconds: { type: 'integer' },
    slow: { type: 'boolean' },
    stallNote: { type: 'string' },
    stallResets: { type: 'integer' },
    threads: { type: 'integer' },
    expandedChunks: { type: 'integer' },
    createdAt: { type: 'integer' },
    startedAt: { type: 'integer' },
    finishedAt: { type: 'integer' },
    visibleInUi: { type: 'boolean' },
    origin: { type: 'string' },
    doh: { type: 'boolean' },
    dohProvider: { type: 'string' },
    github: { type: 'boolean' },
    forceDisplay: { type: 'boolean' },
    checksum: {
      type: 'object',
      additionalProperties: false,
      properties: {
        algorithm: { type: 'string' },
        value: { type: 'string' },
      },
    },
    fingerprint: {
      type: 'object',
      additionalProperties: false,
      properties: {
        state: { type: 'string' },
        note: { type: 'string' },
      },
    },
    siteKey: { type: 'string' },
    siteThrottle: {
      type: 'object',
      additionalProperties: false,
      properties: {
        level: { type: 'integer' },
        connections: { type: 'integer' },
        rateBytes: { type: 'integer' },
        cooldownUntil: { type: 'integer' },
      },
    },
    riskRetries: { type: 'integer' },
    riskNote: { type: 'string' },
  },
}

function makeTool(manager) {
  return {
    name: 'downloader',
    description:
      '多线程（HTTP Range 分片）文件下载器，下载到 dsh Host 本机磁盘。action=add 需要 url，可选 directory/filename/threads；action=list 返回任务与进度（limit 默认 20，visibleInUi 表示是否在面板显示），任务带 remainingBytes 与 etaSeconds（预估剩余秒数）；用返回的 id 执行 pause/resume/cancel/remove；clean 清空已结束任务。下载在 Host 后台继续，不需要等待——不要反复 list 轮询；要等完成时用 list 的 waitSeconds（0..300，任务结束或超时后返回一次）或只查单个 id。小于静默阈值且开关开启时任务静默完成，不出现在面板和对话条，但工具 list 仍可见；需要强制显示时传 forceDisplay=true。可用 singleThread 指定单连接/分片；可选 doh=true 走 DoH 解析、github=true 把 GitHub Release 直链换成 API 资产链接；用户手动下载始终显示并多线程；其余下载由 Agent 控制或受阈值约束。并发上限 = 并发任务数 × 单任务线程数，全局连接数由用户设置（默认 16，范围 1..64），Agent 指定的 threads 同样受此约束。设备高负载时实际并发会被自动压低；同一站点的并发与聚合限速由站点风控策略单独控制（403/429/503/567 后自动降档），这两项都在用户设置里，Agent 无法关闭。自动模式下的并发会在下载过程中爬升：起步按大小阶梯（4/6/8），若每条连接都被限速、全局预算有空闲，就每 3 秒（起步阶段 1.2 秒）切出一段剩余区间加一条连接（每次最多 2 条），最多 8 条；先跑完的分片交还的连接会被立刻填上，收尾阶段也保持满并发（所以分片条数可能多于 8，但同时在用的连接不会超过 8）。已下载的字节原地保留，不需要重下。',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          task: TASK_SCHEMA,
          tasks: { type: 'array', items: TASK_SCHEMA },
          total: { type: 'integer' },
          waitedSeconds: { type: 'integer' },
          timedOut: { type: 'boolean' },
          removed: { type: 'string' },
          cleaned: { type: 'integer' },
          directory: { type: 'string' },
          defaultThreads: { type: 'integer' },
          agentAutonomy: { type: 'boolean' },
          autoThreads: { type: 'boolean' },
          fingerprintResume: { type: 'boolean' },
          silentEnabled: { type: 'boolean' },
          largeFileMb: { type: 'integer' },
          minThreadMb: { type: 'integer' },
          maxConnections: { type: 'integer' },
          activeConnections: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => toolText(JSON.stringify(value, null, 2)),
    },
    async execute(args, exec) {
      const input = args ?? {}
      const signal = exec?.signal
      try {
        switch (input.action) {
          case 'add': {
            const batch = Array.isArray(input.urls) && input.urls.length > 0 ? input.urls : [input.url]
            if (batch.length > 20) throw new Error('一次最多批量添加 20 个地址')
            const tasks = []
            for (const single of batch) {
              const task = await manager.add({
                url: single,
                mirrors: input.mirrors,
                directory: input.directory,
                filename: batch.length === 1 ? input.filename : undefined,
                threads: input.threads,
                singleThread: input.singleThread,
                headers: input.headers,
                sha256: input.sha256,
                checksum: input.checksum,
                doh: input.doh,
                dohProvider: input.dohProvider,
                github: input.github,
                forceDisplay: input.forceDisplay,
                origin: 'agent',
              })
              tasks.push(manager.get(task.id).snapshot())
            }
            return batch.length === 1
              ? { ok: true, action: 'add', task: tasks[0] }
              : { ok: true, action: 'add', tasks }
          }
          case 'list': {
            const limit = Math.min(100, Math.max(1, Math.round(Number(input.limit)) || 20))
            const onlyId = typeof input.id === 'string' && input.id !== '' ? input.id : ''
            const waitSeconds = Math.min(300, Math.max(0, Math.round(Number(input.waitSeconds)) || 0))
            // 有 waitSeconds 时在这一次调用里等任务结束，Agent 不需要反复轮询 list。
            const startedAt = Date.now()
            let timedOut = false
            if (waitSeconds > 0) {
              const deadline = startedAt + waitSeconds * 1000
              const stillRunning = () => [...manager.tasks.values()].some((task) => (
                (onlyId === '' || task.id === onlyId)
                && (task.status === 'queued' || task.status === 'probing' || task.status === 'downloading')
              ))
              while (Date.now() < deadline && stillRunning()) {
                // 用户取消本轮时立刻返回，不要继续阻塞最多 300 秒。
                if (signal?.aborted === true) break
                await new Promise((done) => setTimeout(done, Math.min(1000, Math.max(50, deadline - Date.now()))))
              }
              timedOut = !(signal?.aborted === true) && stillRunning()
            }
            const all = (onlyId === '' ? manager.list() : manager.list().filter((task) => task.id === onlyId))
            if (onlyId !== '' && all.length === 0) throw new Error(`下载任务不存在：${onlyId}`)
            return {
              ok: true,
              action: 'list',
              tasks: all.slice(0, limit).map((task) => ({ ...task, visibleInUi: manager.shouldDisplay(task) })),
              total: all.length,
              waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
              timedOut,
              directory: manager.root,
              defaultThreads: manager.defaultThreads,
              agentAutonomy: manager.agentAutonomy,
              autoThreads: manager.autoThreads,
              fingerprintResume: manager.fingerprintResume,
              silentEnabled: manager.silentEnabled,
              largeFileMb: manager.largeFileMb,
              minThreadMb: manager.minThreadMb,
              maxConnections: manager.maxConnections,
              activeConnections: manager.slots.used,
            }
          }
          case 'clean':
            return { ok: true, action: 'clean', cleaned: manager.clean() }
          case 'pause':
          case 'resume':
          case 'cancel':
          case 'remove': {
            if (typeof input.id !== 'string' || input.id === '') throw new Error('缺少任务 id')
            const result = await manager.control(input.id, input.action)
            return { ok: true, action: input.action, ...result }
          }
          default:
            throw new Error(`未知 action：${String(input.action)}`)
        }
      } catch (error) {
        return { ok: false, action: String(input.action ?? ''), error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/** doh_lookup 工具：批量上限，避免一次解析把 Host 打满。 */
const DOH_LOOKUP_LIMIT = 20

const DOH_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: '要解析的域名；批量用 names。传 IP 时原样返回。' },
    names: { type: 'array', items: { type: 'string' }, description: '批量域名/主机名（最多 20 个），与 name 二选一。' },
    type: {
      type: 'string',
      enum: ['A', 'AAAA', 'both', 'CNAME', 'TXT', 'MX', 'NS', 'SOA', 'PTR', 'SRV', 'CAA', 'HTTPS'],
      description: '记录类型，默认 A；both 表示同时查 A 与 AAAA（最常用于拿真实 IP）。',
    },
    provider: {
      type: 'string',
      enum: ['cloudflare', 'alidns', 'tencent'],
      description: 'DoH 提供商，默认用插件设置里的提供商（AliDNS）。',
    },
    fresh: { type: 'boolean', description: 'true 跳过 60 秒结果缓存，强制重新查询。' },
  },
}

/** 把记录数据压成字符串，保证工具输出 schema 稳定（HTTPS/SOA 是对象）。 */
function flattenDnsAnswer(record) {
  const data = record.data
  return {
    type: record.type,
    ttl: record.ttl,
    data: typeof data === 'string' ? data : JSON.stringify(data),
  }
}

function makeDohTool(manager) {
  return {
    name: 'doh_lookup',
    description:
      '用 DNS over HTTPS 解析域名，不依赖本机 DNS：本机解析被污染或劫持时，先用它拿到真实 IP，再配合 curl --resolve / 请求头直连。name 必填（批量用 names，最多 20 个）；type 默认 A，both = A+AAAA，也支持 CNAME/TXT/MX/NS/SOA/PTR/SRV/CAA/HTTPS；provider 可选 cloudflare/alidns/tencent，默认用插件设置；fresh=true 跳过 60 秒缓存。返回每条记录的类型、TTL、数据，以及 A/AAAA 地址列表。只做解析，不下载、不访问目标站点。',
    parameters: DOH_TOOL_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          provider: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                status: { type: 'integer' },
                cached: { type: 'boolean' },
                ms: { type: 'integer' },
                records: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      type: { type: 'string' },
                      ttl: { type: 'integer' },
                      data: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          addresses: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                address: { type: 'string' },
                family: { type: 'integer' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => toolText(JSON.stringify(value, null, 2)),
    },
    async execute(args) {
      const input = args ?? {}
      try {
        const provider = normalizeDohProvider(input.provider ?? manager.dohProvider)
        const resolver = resolverFor(provider)
        const hosts = (Array.isArray(input.names) && input.names.length > 0 ? input.names : [input.name])
          .map((entry) => String(entry ?? '').trim())
          .filter((entry) => entry !== '')
        if (hosts.length === 0) throw new Error('缺少 name')
        if (hosts.length > DOH_LOOKUP_LIMIT) throw new Error(`一次最多解析 ${DOH_LOOKUP_LIMIT} 个域名`)
        const type = input.type === 'both' ? 'both' : String(input.type ?? 'A')
        const types = type === 'both' ? ['A', 'AAAA'] : [type]
        const results = []
        const addresses = []
        for (const host of hosts) {
          const family = ipFamilyOf(host)
          if (family !== 0 && types.every((single) => single === 'A' || single === 'AAAA')) {
            // 传的就是 IP：不必查 DNS，直接原样返回，避免 DoH 白跑一趟。
            const recordType = family === 4 ? 'A' : 'AAAA'
            results.push({ name: host, type: recordType, status: 0, cached: false, ms: 0, records: [{ type: recordType, ttl: 0, data: host }] })
            addresses.push({ name: host, address: host, family })
            continue
          }
          for (const single of types) {
            const answer = await resolver.query(host, single, { fresh: input.fresh === true })
            results.push({ ...answer, records: answer.records.map(flattenDnsAnswer) })
            for (const record of answer.records) {
              if (record.type === 'A') addresses.push({ name: host, address: record.data, family: 4 })
              if (record.type === 'AAAA') addresses.push({ name: host, address: record.data, family: 6 })
            }
          }
        }
        if (addresses.length === 0 && types.some((single) => single === 'A' || single === 'AAAA')) {
          throw new Error(`DoH 没有解析结果：${hosts.join(', ')}（${provider}）`)
        }
        return { ok: true, provider, results, addresses }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

const PROBE_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', description: '要探测的 http/https 地址。' },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: '可选请求头（Cookie / Referer / Authorization 等）；Range 等下载器控制的头会被忽略。',
    },
    doh: { type: 'boolean', description: 'true 表示用 DoH 解析该地址的域名，适合本机 DNS 被污染时。' },
    dohProvider: { type: 'string', enum: ['cloudflare', 'alidns', 'tencent'], description: 'doh=true 时的提供商，默认用插件设置。' },
  },
  required: ['url'],
}

function makeProbeTool(manager) {
  return {
    name: 'http_probe',
    description:
      '探测一个 http/https 地址的响应头，不下载正文（只发 HEAD，必要时补一个 bytes=0-0 的 Range 请求）。返回文件大小、是否支持 Range（能否分片/续传）、Content-Disposition 文件名、ETag 与 Last-Modified，并在 401/403 时说明需要 headers 提供 Cookie / Referer / Authorization。可选 headers 与 doh=true（DoH 解析）。下载前用它确认可分片、断点续传可信度，或诊断 403/防盗链。',
    parameters: PROBE_TOOL_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          url: { type: 'string' },
          size: { type: 'integer' },
          ranges: { type: 'boolean' },
          filename: { type: 'string' },
          etag: { type: 'string' },
          lastModified: { type: 'string' },
          contentType: { type: 'string' },
          warning: { type: 'string' },
          resolvedUrl: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => toolText(JSON.stringify(value, null, 2)),
    },
    async execute(args) {
      const input = args ?? {}
      try {
        const url = String(input.url ?? '').trim()
        if (url === '') throw new Error('缺少 url')
        const dispatcher = input.doh === true
          ? createDohDispatcher(input.dohProvider ?? manager.dohProvider)
          : undefined
        try {
          const result = await probe(url, AbortSignal.timeout(60_000), sanitizeHeaders(input.headers), dispatcher)
          // finalUrl 是内部字段：只在确实跳转过时以 resolvedUrl 暴露，便于诊断镜像/CDN。
          const { finalUrl, ...rest } = result
          const name = rest.filename !== '' ? rest.filename : filenameFromUrl(new URL(url))
          // 目标不是网页却回 text/html：几乎总是 WAF 拦截页或登录页，提前说明比下完再报错好。
          const warning = looksLikeHtmlBlock(rest.contentType, name)
            ? '响应类型是 text/html：目标不是网页时这通常是被 WAF 拦截或需要登录，正文是拦截页而不是文件；请检查 headers（Cookie / Referer）'
            : ''
          return {
            ok: true,
            url,
            ...(typeof finalUrl === 'string' && finalUrl !== '' && finalUrl !== url ? { resolvedUrl: finalUrl } : {}),
            ...rest,
            ...(warning !== '' ? { warning } : {}),
          }
        } finally {
          // DoH 解析用的 Agent 是一次性的，不关会一直占着连接。
          dispatcher?.close?.()
        }
      } catch (error) {
        return { ok: false, url: String(input.url ?? ''), error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function makeRoutes(manager) {
  const guard = (request, response) => {
    if (isTrustedRequest(request)) return true
    writeJson(response, 403, { ok: false, error: 'forbidden' })
    return false
  }
  const requireJson = (request, response) => {
    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      writeJson(response, 415, { ok: false, error: 'json-required' })
      return false
    }
    return true
  }

  return [
    {
      kind: 'exact',
      path: `${API_PREFIX}/state`,
      handler: (request, response) => {
        if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(request, response) || !requireJson(request, response)) return
        writeJson(response, 200, {
          ok: true,
          tasks: manager.list(true).filter((task) => manager.shouldDisplay(task)),
          directory: manager.root,
          defaultThreads: manager.defaultThreads,
          maxConnections: manager.maxConnections,
          activeConnections: manager.slots.used,
          effectiveConnections: manager.effectiveConnections,
          maxConcurrent: manager.maxConcurrent,
          loadAdaptive: manager.loadAdaptive,
          siteAdaptive: manager.siteAdaptive,
          resources: manager.resourceState(),
          sites: manager.siteGovernor.snapshot(),
          active: manager.activeCount(),
          largeFileBytes: manager.largeFileBytes,
          largeFileMb: manager.largeFileMb,
          minThreadBytes: manager.minThreadBytes,
          minThreadMb: manager.minThreadMb,
          minThreadEnabled: manager.minThreadEnabled,
          agentAutonomy: manager.agentAutonomy,
          autoThreads: manager.autoThreads,
          fingerprintResume: manager.fingerprintResume,
          silentEnabled: manager.silentEnabled,
          rateLimitBytes: manager.rateLimitBytes,
          dohEnabled: manager.dohEnabled,
          dohProvider: manager.dohProvider,
          githubEnabled: manager.githubEnabled,
          stallWatchdog: manager.stallWatchdog,
          stallWindowSec: manager.stallWindowSec,
          settingsPath: manager.settingsPath,
          // 面板整体 ETA 与输入框上方的进度条同源：都用平滑速度算出来的那一个。
          etaSeconds: manager.summary().etaSeconds,
        })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/summary`,
      handler: (request, response) => {
        if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(request, response) || !requireJson(request, response)) return
        writeJson(response, 200, { ok: true, ...manager.summary() })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/add`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(request, response) || !requireJson(request, response)) return
        try {
          const body = await readJsonBody(request, 64 * 1024)
          const task = await manager.add({
            url: body.url,
            mirrors: body.mirrors,
            directory: body.directory,
            filename: body.filename,
            threads: body.threads,
            singleThread: body.singleThread,
            headers: body.headers,
            sha256: body.sha256,
            checksum: body.checksum,
            doh: body.doh,
            dohProvider: body.dohProvider,
            github: body.github,
            forceDisplay: body.forceDisplay,
            origin: 'user',
          })
          writeJson(response, 200, { ok: true, task })
        } catch (error) {
          writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/control`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(request, response) || !requireJson(request, response)) return
        try {
          const body = await readJsonBody(request, 64 * 1024)
          if (typeof body.id !== 'string' || body.id === '') throw new Error('缺少任务 id')
          const result = await manager.control(body.id, body.action)
          writeJson(response, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/pick-directory`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(request, response) || !requireJson(request, response)) return
        try {
          const body = await readJsonBody(request, 8 * 1024)
          const dialog = await electronDialog()
          const helper = process.platform === 'win32' && existsSync(NATIVE_PICKER)
          const native = dialog !== null || helper || process.platform === 'darwin' || process.platform === 'linux'
          if (body.probe === true) {
            writeJson(response, 200, { ok: true, native, electron: dialog !== null, helper, platform: process.platform })
            return
          }
          const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim().slice(0, 80) : '选择下载目录'
          if (!native) {
            writeJson(response, 200, { ok: true, native: false, path: null })
            return
          }
          const initial = typeof body.initial === 'string' ? body.initial : ''
          const picked = await pickNativeDirectory(title, initial)
          writeJson(response, 200, { ok: true, native: true, path: picked ?? null })
        } catch (error) {
          // 选择器本身失败要如实报告，不能伪装成「用户取消」。
          writeJson(response, 200, { ok: false, native: false, path: null, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/browse`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(request, response) || !requireJson(request, response)) return
        try {
          const body = await readJsonBody(request, 8 * 1024)
          writeJson(response, 200, { ok: true, ...(await browseDirectory(body.path)) })
        } catch (error) {
          writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/settings`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(request, response) || !requireJson(request, response)) return
        try {
          const body = await readJsonBody(request, 16 * 1024)
          const applied = manager.applySettings(body)
          writeJson(response, 200, { ok: true, ...applied })
        } catch (error) {
          writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}

export const inject = ['tools', 'webServer']

/** 每次模型请求注入的简短公告；工具被 restrict 隐藏时自动消失。 */
const TOOL_GUIDANCE =
  '多线程下载器：需要把 http/https 文件下载到这台机器时，使用 downloader 工具（action=add 新建，list 查看进度，pause/resume 断点续传，cancel/remove 清理）。下载在 Host 后台进行，不必等待完成——不要反复调用 list 轮询；确实要等结果时用 list 的 waitSeconds（最多 300 秒，任务结束或超时后返回一次），或在需要时看一次任务上的 etaSeconds 预估剩余秒数。支持自定义请求头（Cookie/Referer/Authorization）、镜像回退、批量 URL、多算法校验、分片重试与全局限速；可选 DoH 解析与 GitHub 资产解析；小于静默阈值（默认 16 MB，可关闭，关闭后显示全部任务）的文件静默下载，不在面板和对话中显示；达到阈值的任务显示进度曲线；小于单线程阈值（默认 4 MB）的文件单连接下载，更大文件按大小自动 4/6/8 条连接（可显式指定 threads），运行中若每条连接都被限速，并发会自动爬升到最多 8 条并在收尾时保持满并发（先跑完的分片把连接交还给还长的剩余区间；已下载字节保留，不必为提速重建任务）。续传前与收尾都会用 ETag/Last-Modified 指纹复核，分片请求带 If-Range，远端换版本会自动从头重下。连接半死却还在涓流时会由停滞看门狗换一组连接（不消耗重试预算），任务会带上 stallNote；两次仍极慢则标记 slow 并继续下，不会失败——遇到这种情况不必取消重建。并发上限 = 并发任务数 × 单任务线程数，全局连接数由用户设置（默认 16，范围 1..64），Agent 指定的线程数同样受此约束、无法绕过；Host 还会按设备 CPU/内存负载自动收缩并发，并对触发风控的站点按站点降并发、加聚合限速（不同站点互不影响）。用户手动下载（面板填 URL/目录/线程）始终显示并多线程；其余下载视为 Agent 任务，受静默/单线程阈值约束，Agent 自主模式下可由 Agent 指定线程策略。本机 DNS 被污染或怀疑解析异常时，用同插件提供的 doh_lookup 直接走 DoH 解析（name 必填，type=both 同时取 A/AAAA，provider 可选）；下载前想确认大小、是否支持 Range、ETag 与 403 原因时用 http_probe（只发 HEAD/1 字节 Range，不下载正文）。这两个工具与 downloader 任务独立，不占连接配额。完整用法见 skill multithread-downloader。'

/** 注册给所有会话的技能正文（按需加载，不占常驻提示）。 */
const SKILL_CONTENT = `# 多线程下载器（downloader）

## 何时使用

- 用户给出 http/https 地址，要求下载、保存、抓取文件到这台机器时。
- 需要断点续传、限制线程数，或需要实时进度曲线时优先用它。
- 浏览器页面内的点击/登录不属于本技能，使用 ego_* 浏览器工具。

## 工具

\`downloader({ action, url? | urls?, mirrors?, headers?, checksum?, sha256?, id?, directory?, filename?, threads? })\`

### action=add

- \`url\` 必填，只支持 http/https。
- \`directory\` 可选，Host 本机绝对路径；省略则用插件默认目录（Known Folder / 用户 Downloads）。面板里点“选择…”：Electron 桌面环境使用系统原生目录对话框（标题“选择下载目录”）；其他环境使用插件内目录浏览器（同样标题，支持面包屑与选择当前目录）。
- \`filename\` 可选，只写文件名，不要带路径分隔符。
- \`threads\` 可选，1..16；省略时按大小自动（<32 MB 4 条、<256 MB 6 条、更大 8 条，可被 autoThreads 关闭），显式给出则固定；服务器不支持 Range 时自动回退单连接。所有任务共享并发限制数（默认 16，= 任务数 × 线程数），超出部分排队，Agent 无法绕过。
- 并发会在下载中**爬升**（自动模式）：每条连接都被限速、且全局预算有空闲时，起步阶段每 1.2 秒、之后每 3 秒把一个分片的剩余区间对半切开、多起一条连接（每次最多 2 条），最多 8 条同时在用（显式指定 threads 时不爬升）。先跑完的分片会把连接交还回来，那一刻立刻把还长的剩余区间切一段给它，所以收尾阶段也是满并发（分片条数可能多于 8，连接数不会）。已下载字节原地保留，不会重下——所以**不需要**为提速而取消重建任务。
- \`headers\` 可选对象：Cookie / Referer / Authorization 等；遇到 401/403 必须提供。
- \`checksum\` 可选：\`{ algorithm, value }\`，algorithm 支持 md5/sha1/sha256/sha512/crc32，完成后校验，不匹配则任务失败。
- \`sha256\` 可选：兼容旧参数，等价于 \`checksum: { algorithm: 'sha256', value }\`。
- \`urls\` 可选数组：批量创建（最多 20 个），\`mirrors\` 为每个任务提供备用镜像。
- 分片失败会自动重试（指数退避，最多 4 次），并对 5xx/429/超时生效。
- 断点续传会先复核远端指纹（旁证文件 + Content-Length + ETag/Last-Modified），分片请求带 \`If-Range\`；远端换了版本会自动丢弃旧分片从头重下，收尾还会再核对一次，避免交付拼接文件。
- 小于单线程阈值（默认 4 MB，可关闭）的文件只建一个分片、单连接下载。
- \`singleThread\` 可选：true 强制单连接，false 强制分片；省略时普通模式按阈值，Agent 自主模式下默认分片。
- \`doh\` 可选：true 让该任务走 DoH 解析；\`dohProvider\` 可选 cloudflare / alidns / tencent。
- \`github\` 可选：true 时把 \`github.com/.../releases/download/...\` 换成 API 资产链接，绕过 github.com 被污染。
- \`forceDisplay\` 可选：true 时覆盖静默阈值，强制在面板/对话条显示，并显示速度曲线。
- 返回任务对象，\`id\` 用于后续控制；下载继续在 Host 后台进行，不要等待它完成。

### action=list

返回任务：状态、进度、速度、剩余字节（\`remainingBytes\`）、预估剩余秒数（\`etaSeconds\`，仅在正在下载且速度有效时给出）、保存路径、错误信息；\`waitedSeconds\` 表示本次调用等了多少秒，\`timedOut: true\` 表示等到了超时但任务仍在跑。达到曲线阈值（默认 16 MB）的任务在面板里还有 \`history\`（每秒一个 \`{t,p,s}\` 采样点），工具输出不含它。

- \`id\` 可选：只返回该任务，用来省掉整表输出；id 不存在会返回明确错误，不是空列表。
- \`limit\` 可选：最多返回多少条（1..100，默认 20），\`total\` 是任务总数。
- \`waitSeconds\` 可选：最多等多少秒（0..300，默认 0）。期间每秒检查一次，任务全部结束或超时后返回——**要等下载完成就用它，不要连续调用 list 轮询**。

### action=pause / resume / cancel / remove

用 \`id\` 指定任务：

- \`pause\`：暂停，保留已下载分片，之后可续传；排队中的任务会直接移出队列。
- \`resume\`：从各分片断点继续；\`failed\` 状态也可重试。已取消/已完成的任务会返回明确错误。
- \`cancel\`：取消并删除 \`.mtd-part\` 临时文件。
- \`remove\`：移除任务记录（必要时先取消）。

### action=clean

清空已完成/失败/已取消的任务记录。

## 配套工具（与 downloader 独立）

这两个工具共用插件内的同一套网络模块，但不会创建下载任务、不占连接配额，任何会话都能直接调用。

### doh_lookup

\`doh_lookup({ name, names?, type?, provider?, fresh? })\`

- 用 DNS over HTTPS 解析域名，不依赖本机 DNS；本机解析被污染时先拿到真实 IP，再用 \`curl --resolve\` 或请求头直连。
- \`name\` 必填，批量用 \`names\`（最多 20 个）；传 IP 时原样返回。
- \`type\` 默认 \`A\`，\`both\` 同时查 A + AAAA；也支持 CNAME / TXT / MX / NS / SOA / PTR / SRV / CAA / HTTPS。
- \`provider\` 可选 cloudflare / alidns / tencent，默认用插件设置；\`fresh: true\` 跳过 60 秒缓存。
- 返回每条记录的类型、TTL、数据，以及 A/AAAA 地址列表。

### http_probe

\`http_probe({ url, headers?, doh?, dohProvider? })\`

- 只发 HEAD，必要时补一个 \`bytes=0-0\` 的 Range 请求，不下载正文。
- 返回大小、是否支持 Range（能否分片/续传）、Content-Disposition 文件名、ETag 与 Last-Modified。
- 401/403 时直接说明需要 \`headers\` 提供 Cookie / Referer / Authorization；可选 \`doh: true\` 走 DoH 解析。

## 面板设置（Web GUI 侧边栏「多线程下载器」）

所有设置收在面板底部的 **设置** 卡片里，默认收起，点标题展开；展开后按四组排列：**连接与带宽**、**下载与续传**、**Agent 与阈值**、**网络与站点**。收起时标题栏右侧显示当前关键值（并发数、限速、静默阈值、DoH 状态）。



- **全局限速**：KB/s，0 表示不限；所有任务共享。
- **并发限制数**：1..64，默认 16；这里限制的是**连接数**，即同时下载的任务数 × 每个任务的线程数。超出部分排队，Agent 自主模式同样受它约束、不能绕过。
- **设备负载自适应**（默认开）：每 2 秒采样 CPU 与内存占用，压力高时立即把实际连接预算压到设定值的一部分（最多压到 20%），资源回落后每两个采样周期抬一档，约半分钟恢复满速（默认上限 16 时约 28 秒）。设备性能一般时无需手动调小并发。
- **站点风控自适应**（默认开）：同一网站（按注册域归并，含 cdn/www 等子域和不同页面）返回 403/429/503/567 时，该站点自动降一档——并发 4 → 2 → 1，聚合限速 2 MB/s → 768 → 256 → 128 KB/s，并冷却 3 → 8 → 20 → 60 秒后继续；连续成功若干段后逐档恢复。**不同网站各自独立**，被风控的站点不会拖慢其它站点，也不会占用全局连接预算等待冷却。

- **静默下载阈值**：带独立开关，默认开启、16 MB，单位 KB / MB / GB，范围 1 KB–10 GB。仅约束 Agent 发起的下载：小于该值时静默（不进面板/对话条/计数）；用户手动下载始终显示。关闭开关后所有任务都显示。
- **单线程阈值**：带独立开关，默认开启、阈值 4 MB，单位 KB/MB。仅约束 Agent 发起的下载；用户手动下载始终按所选线程数分片。关闭后 Agent 任务也不做单连接降级。
- **Agent 自主模式**：默认开启。开启后面板上的静默/单线程设置被屏蔽（数值保留，仍约束 Agent 任务）；Agent 可用 \`threads\` / \`singleThread\` 指定自己的策略。用户手动下载不受影响。
- **DoH 解析**：面板开关，开启前有风险确认；可选 Cloudflare / AliDNS / Tencent。Agent 可用 \`doh\` / \`dohProvider\` 为单个任务启用。
- **GitHub 模式**：Agent 用 \`github: true\` 把 Release 直链换成 API 资产链接，避免 github.com DNS 污染。
- **停滞看门狗**（默认开）：连接半死却还在涓流（几 B/s）时，按窗口吞吐（默认 60 秒、64 KB 下限）判定停滞并换一组新连接，不消耗重试预算；换两次仍极慢就标记「远端极慢」（任务带 \`slow: true\`、不再给 ETA），继续下载而不判失败。限速跟随：用户设的全局限速与站点聚合限速会压低判定下限，不会误判。
- 以上都是 Host 级设置，自动保存到 profile 目录下的 \`multithread-downloader.json\`，DSH 重启后恢复；\`cordis.patch.yml\` 只作为首次默认值。

## 界面

- 侧边栏「多线程下载器」图标显示未完成任务数（行尾或图标角标）。
- 对话输入框上方有实时进度条：多任务按总大小切成多段，显示已下载/总大小、聚合百分比、总速度；右侧方形箭头可收起，收起后点居中的胶囊恢复。
- 任务卡片显示进度、速度、线程数、暂停/继续/取消/移除；达到阈值的任务显示进度曲线与 ETA。

## 判断完成

- 推荐：\`downloader({ action: 'list', id, waitSeconds: 60 })\`，返回时任务若已结束就是最终状态，不用轮询。
- \`status=completed\` 且 \`receivedBytes == totalBytes\` 即完成；\`path\` 是最终保存路径。
- \`status=failed\` 时看 \`error\`：常见为 HTTP 状态码、服务器忽略 Range、文件大小不符。
- 想告诉用户还要多久，用 \`etaSeconds\`（任务级）或 \`/summary\` 的总 \`etaSeconds\`；进度用 \`progress\`（0..1）。

## 注意

- 下载目录是本机（dsh Host）路径，不是浏览器所在设备。
- 需要登录/防盗链的文件请通过 \`headers\` 提供 Cookie / Referer / Authorization；本插件不接管浏览器登录态。
- 任务列表保存在 Host 内存中，DSH 重启后任务记录丢失，但已完成的文件仍在磁盘。
- 同名文件会自动追加 \` (1)\` 等后缀，不会覆盖已有文件。
- 阈值设置属于插件 UI；agent 工具没有修改设置的 action。
`


export function apply(ctx, config) {
  const directory = typeof config?.directory === 'string' && config.directory.trim() !== ''
    ? resolve(config.directory.trim())
    : defaultDownloadDirectory()
  const profileDirectory = resolveProfileDirectory()
  const settingsPath = join(profileDirectory, 'multithread-downloader.json')
  const tasksPath = join(profileDirectory, 'multithread-downloader-tasks.json')
  const manager = new Downloader({
    directory,
    threads: numberConfig(config?.threads, 4, 1, MAX_THREADS),
    maxConnections: clampConnections(config?.maxConnections),
    largeFileMb: numberConfig(config?.largeFileMb, DEFAULT_LARGE_FILE_MB, 1, 10240),
    minThreadMb: numberConfig(config?.minThreadMb, DEFAULT_MIN_THREAD_MB, 0, 10240),
    minThreadEnabled: config?.minThreadEnabled !== false,
    agentAutonomy: config?.agentAutonomy !== false,
    autoThreads: config?.autoThreads !== false,
    fingerprintResume: config?.fingerprintResume !== false,
    silentEnabled: config?.silentEnabled !== false,
    loadAdaptive: config?.loadAdaptive !== false,
    siteAdaptive: config?.siteAdaptive !== false,
    rateLimitBytes: numberConfig(config?.rateLimitKb, 102400, 0, 1024 * 1024) * 1024,
    dohEnabled: config?.dohEnabled === true,
    dohProvider: normalizeDohProvider(config?.dohProvider),
    githubEnabled: config?.githubEnabled === true,
    stallWatchdog: config?.stallWatchdog !== false,
    stallWindowMs: numberConfig(config?.stallWindowSec, 60, 10, 600) * 1000,
    settingsPath,
    tasksPath,
  })
  const persistedSettings = readSettingsFile(settingsPath)
  if (Object.keys(persistedSettings).length > 0) {
    try {
      manager.applySettings(persistedSettings)
    } catch {
      // 本地文件损坏或越界时保留配置默认值。
    }
  }
  // 旧 schema 里已失效的键（例如 v10 的 maxConcurrent）不会被读取，
  // 顺手把文件重写成当前 schema，避免下次启动继续带着它们。
  if (persistedSettings.schemaVersion !== SETTINGS_SCHEMA_VERSION) manager.persistSettings()

  ctx.effect(() => () => {
    manager.dispose()
  }, 'multithread-downloader: tasks')

  ctx.effect(() => {
    const disposers = makeRoutes(manager).map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'multithread-downloader: routes')

  ctx.effect(() => ctx.tools.register(makeTool(manager)), 'multithread-downloader: tool')
  ctx.effect(() => ctx.tools.register(makeDohTool(manager)), 'multithread-downloader: doh tool')
  ctx.effect(() => ctx.tools.register(makeProbeTool(manager)), 'multithread-downloader: probe tool')

  if (config?.announceToAgent !== false) {
    ctx.inject(['systemPrompt'], (scoped) => {
      scoped.effect(
        () =>
          scoped.systemPrompt.section({
            name: 'plugin:multithread-downloader',
            order: 220,
            text: (context) => {
              try {
                return ctx.tools.get('downloader', context.scope) === undefined ? '' : TOOL_GUIDANCE
              } catch {
                return TOOL_GUIDANCE
              }
            },
          }),
        'multithread-downloader: prompt section',
      )
    })
  }

  ctx.inject(['skills'], (scoped) => {
    scoped.effect(
      () =>
        scoped.skills.register({
          name: 'multithread-downloader',
          description: '用 downloader 工具把 http/https 文件下载到 dsh Host：分片并发、断点续传；静默下载阈值与单线程阈值可调。',
          whenToUse: '用户要求下载或保存网络文件（尤其大文件、需要暂停/续传、需要指定目录或线程数）时。',
          content: SKILL_CONTENT,
          source: 'runtime',
          invocation: { modelInvocable: true, userInvocable: false },
        }),
      'multithread-downloader: skill',
    )
  })
}

/** 仅用于测试的纯函数导出；DSH 加载器会忽略额外命名导出。 */
export const __test = { apply, makeTool, makeRoutes, TOOL_PARAMETERS, TASK_SCHEMA, sanitizeHeaders, retryDelay, RateLimiter, ConnectionSlots, probe, fetchWithRedirects, fileSha256, fileChecksum, normalizeChecksum, CHECKSUM_ALGORITHMS, freeDiskBytes, defaultDownloadDirectory, parseGithubReleaseUrl, normalizeDohProvider, DOH_PROVIDERS, autoThreadsForBytes, fingerprintChange, ifRangeValue, DownloadTask, Downloader, LoadGovernor, ResourceSampler, SiteGovernor, SiteLimiter, siteKeyForUrl, cpuPercentBetween, loadStepFor, memoryPressurePercent, signedUrlExpiry, headersForRedirect, httpStatusOf, SITE_LEVELS, RISK_STATUS, SITE_RISK_DEDUP_MS, SITE_DECAY_MS, makeDohTool, makeProbeTool, resolverFor }
