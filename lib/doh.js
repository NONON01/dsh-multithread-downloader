/**
 * DNS over HTTPS（DoH）—— 从下载器拆出的可复用模块。
 *
 * 这里只有「把域名解析成地址」这一件事，不关心下载状态：
 * - `createDohResolver()` 返回一个可复用的解析器（带 TTL 缓存），可直接查询 A/AAAA/CNAME/TXT 等记录；
 * - `createDohDispatcher()` 返回 undici dispatcher，让任意 fetch 走 DoH 解析（失败回退系统 DNS）；
 * - `resolveAddresses()` 是一次性便捷入口。
 *
 * 下载器的 `doh` 选项、`doh_lookup` 工具都复用这里的实现，避免两份 DNS 逻辑。
 */
import { lookup as systemLookup } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'

export const DOH_PROVIDERS = Object.freeze({
  cloudflare: { label: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  alidns: { label: 'AliDNS', url: 'https://dns.alidns.com/resolve' },
  tencent: { label: 'Tencent', url: 'https://doh.pub/dns-query' },
})

/** 记录类型 → DNS 数值类型；DoH JSON 响应只给数值，回读时要反查。 */
export const DNS_TYPES = Object.freeze({
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  HTTPS: 65,
  CAA: 257,
})

const DNS_TYPE_NAMES = new Map(Object.entries(DNS_TYPES).map(([name, code]) => [code, name]))
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 512

/** 收敛 DoH 提供商；未知值回退 AliDNS。 */
export function normalizeDohProvider(value) {
  return typeof value === 'string' && Object.hasOwn(DOH_PROVIDERS, value) ? value : 'alidns'
}

/** 判断字符串是不是 IP 字面量（IPv4 / IPv6）。 */
export function isIpLiteral(value) {
  return isIP(String(value ?? '').trim()) !== 0
}

/** IP 字面量的地址族：4 / 6，非 IP 返回 0。 */
export function ipFamilyOf(value) {
  return isIP(String(value ?? '').trim())
}

/** 收敛记录类型：接受大小写与数值；未知类型直接报错，避免静默返回空结果。 */
export function normalizeDnsType(value) {
  if (typeof value === 'number' && Number.isInteger(value) && DNS_TYPE_NAMES.has(value)) return value
  const raw = String(value ?? 'A').trim().toUpperCase()
  if (raw === '' || raw === 'BOTH') return DNS_TYPES.A
  if (Object.hasOwn(DNS_TYPES, raw)) return DNS_TYPES[raw]
  if (/^\d+$/.test(raw) && DNS_TYPE_NAMES.has(Number(raw))) return Number(raw)
  throw new Error(`不支持的记录类型：${value}（可选 ${Object.keys(DNS_TYPES).join(' / ')}）`)
}

function typeName(code) {
  return DNS_TYPE_NAMES.get(code) ?? `TYPE${code}`
}

/**
 * 创建解析器。
 * @param {object} [options]
 * @param {string} [options.provider] cloudflare | alidns | tencent
 * @param {number} [options.timeoutMs] 单次 DoH 查询超时，默认 5 秒
 * @param {number} [options.cacheTtlMs] 结果缓存时长，默认 60 秒；0 表示不缓存
 */
export function createDohResolver(options = {}) {
  const provider = normalizeDohProvider(options.provider)
  const endpoint = typeof options.endpoint === 'string' && options.endpoint !== ''
    ? options.endpoint
    : DOH_PROVIDERS[provider].url
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? Math.max(0, options.cacheTtlMs) : DEFAULT_CACHE_TTL_MS
  const cache = new Map()

  function cacheGet(key) {
    const entry = cache.get(key)
    if (entry === undefined) return null
    if (entry.expires <= Date.now()) {
      cache.delete(key)
      return null
    }
    return entry.value
  }

  function cacheSet(key, value) {
    if (cacheTtlMs <= 0) return
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, { value, expires: Date.now() + cacheTtlMs })
  }

  /**
   * 查询一种记录。
   * @returns {Promise<{name:string,type:string,status:number,records:Array<{type:string,ttl:number,data:unknown}>,cached:boolean,ms:number}>}
   */
  async function query(name, type = 'A', settings = {}) {
    const hostname = String(name ?? '').trim().replace(/\.$/, '')
    if (hostname === '') throw new Error('缺少域名')
    if (hostname.length > 253) throw new Error('域名过长')
    const code = normalizeDnsType(type)
    const key = `${provider}:${code}:${hostname.toLowerCase()}`
    if (settings.fresh !== true) {
      const hit = cacheGet(key)
      if (hit !== null) return { ...hit, cached: true }
    }
    const target = new URL(endpoint)
    target.searchParams.set('name', hostname)
    target.searchParams.set('type', String(code))
    const startedAt = Date.now()
    let response
    try {
      response = await undiciFetch(target, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      // 裸的「fetch failed」对用户没有信息量：说清是哪个提供商不通，并给出可换的选项。
      const cause = error?.cause
      const reason = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error))
      throw new Error(`DoH 请求失败（${provider}：${reason}）。本机网络可能不通这个提供商，换 alidns 或 tencent 再试`)
    }
    if (!response.ok) throw new Error(`DoH HTTP ${response.status}（${provider}）`)
    const data = await response.json()
    const answers = Array.isArray(data.Answer) ? data.Answer : []
    const records = answers.map((answer) => ({
      type: typeName(Number(answer.type)),
      ttl: Number(answer.TTL) || 0,
      data: answer.data,
    }))
    const value = {
      name: hostname,
      type: typeName(code),
      status: Number(data.Status) || 0,
      records,
      cached: false,
      ms: Date.now() - startedAt,
    }
    if (value.status === 0) cacheSet(key, { ...value, cached: false })
    return value
  }

  /** 解析 A + AAAA，返回去重后的地址列表；两者都为空时按解析失败处理。 */
  async function resolve(name, settings = {}) {
    const hostname = String(name ?? '').trim().replace(/\.$/, '')
    if (isIP(hostname) !== 0) {
      return {
        name: hostname,
        provider,
        addresses: [{ address: hostname, family: isIP(hostname) }],
        records: [],
        cached: false,
      }
    }
    const [ipv4, ipv6] = await Promise.all([
      query(hostname, 'A', settings),
      query(hostname, 'AAAA', settings).catch(() => null),
    ])
    const addresses = [
      ...ipv4.records.filter((record) => record.type === 'A').map((record) => ({ address: String(record.data), family: 4 })),
      ...(ipv6?.records ?? []).filter((record) => record.type === 'AAAA').map((record) => ({ address: String(record.data), family: 6 })),
    ]
    if (addresses.length === 0) throw new Error(`DoH 没有解析结果：${hostname}`)
    return {
      name: hostname,
      provider,
      addresses,
      records: [...ipv4.records, ...(ipv6?.records ?? [])],
      cached: ipv4.cached && (ipv6?.cached ?? true),
    }
  }

  return { provider, endpoint, query, resolve, clear: () => cache.clear() }
}

/** 按提供商缓存解析器，重复调用复用同一份 DNS 缓存。 */
const resolvers = new Map()
export function resolverFor(provider, options = {}) {
  const key = normalizeDohProvider(provider)
  let resolver = resolvers.get(key)
  if (resolver === undefined) {
    resolver = createDohResolver({ ...options, provider: key })
    resolvers.set(key, resolver)
  }
  return resolver
}

/**
 * 一次性解析入口：不共享缓存，适合脚本直接调用。
 * @returns {Promise<{address:string,family:number}[]>}
 */
export async function resolveAddresses(hostname, options = {}) {
  return (await createDohResolver(options).resolve(hostname)).addresses
}

/**
 * 创建一个走 DoH 的 undici dispatcher；DoH 失败时回退系统 DNS，保证下载不会因为
 * 解析服务不可用而彻底失败（回退行为会体现在调用方的风险提示里）。
 */
export function createDohDispatcher(provider, options = {}) {
  const resolver = createDohResolver({ provider })
  const onFallback = typeof options.onFallback === 'function' ? options.onFallback : null

  const lookup = (hostname, lookupOptions, callback) => {
    if (isIP(hostname) !== 0) {
      systemLookup(hostname, lookupOptions, callback)
      return
    }
    resolver.resolve(hostname)
      .then(({ addresses }) => {
        if (lookupOptions?.all === true) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      })
      .catch((error) => {
        // DoH 不可用时保持可用性；风险提示会说明存在回退。
        onFallback?.(hostname, error)
        systemLookup(hostname, lookupOptions, callback)
      })
  }

  return new Agent({ connect: { lookup } })
}
