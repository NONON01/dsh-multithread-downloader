/**
 * HTTP 探测与请求工具（从下载器拆出的可复用模块）。
 *
 * 只做「发请求、拿响应头、判断可重试」这类与下载状态无关的事：
 * URL 校验、请求头规范化、跟随重定向、大小 / Range / ETag 探测、
 * 远端指纹比较与 GitHub Release 资产解析。
 */
import { fetch as undiciFetch } from 'undici'
import { filenameFromDisposition } from './files.js'
import { sleep } from './limits.js'

const USER_AGENT = 'DSH-MultithreadDownloader/1.0'
const MAX_ATTEMPTS = 4
const REQUEST_TIMEOUT_MS = 30_000
/**
 * 值得重试的状态：明确的可恢复错误加上 Cloudflare 那一组 5xx。
 * 520/521/522/524/530 是 Cloudflare 自己的错误码（源站未知错误、握手失败、连接超时、
 * 超时、源站 DNS 失败），它们既不是 200 也不是「本站被限流」，只重试一次就判失败太早：
 * 实测远端偶发 522 时，重试一次即成功。
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524, 530])
const FORBIDDEN_HEADERS = new Set(['range', 'if-range', 'content-length', 'host', 'connection', 'accept-encoding'])

/** URL 只接受 http/https。 */
function parseHttpUrl(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new Error('无效的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https URL')
  return url
}

/** 比较两次探测结果；返回到变化的字段名，未变化返回空串。 */
function fingerprintChange(before, after) {
  if (before === null || before === undefined || after === null || after === undefined) return ''
  const beforeSize = Number(before.size) || 0
  const afterSize = Number(after.size) || 0
  if (beforeSize > 0 && afterSize > 0 && beforeSize !== afterSize) return 'size'
  const beforeEtag = typeof before.etag === 'string' ? strongEtag(before.etag) : ''
  const afterEtag = typeof after.etag === 'string' ? strongEtag(after.etag) : ''
  if (beforeEtag !== '' && afterEtag !== '' && beforeEtag !== afterEtag) return 'etag'
  const beforeModified = typeof before.lastModified === 'string' ? before.lastModified : ''
  const afterModified = typeof after.lastModified === 'string' ? after.lastModified : ''
  if (beforeModified !== '' && afterModified !== '' && beforeModified !== afterModified) return 'last-modified'
  return ''
}

/** If-Range 只接受强 ETag；弱 ETag（W/"…"）按规范必须回退到 Last-Modified。 */
function ifRangeValue(etag, lastModified) {
  if (typeof etag === 'string' && etag !== '' && !/^W\//i.test(etag)) return etag
  if (typeof lastModified === 'string' && lastModified !== '') return lastModified
  return ''
}

/** 比较 ETag 时去掉弱校验前缀：`W/"x"` 与 `"x"` 是同一个版本。 */
function strongEtag(etag) {
  return typeof etag === 'string' ? etag.replace(/^W\//i, '') : ''
}

/** 把 401/403/407/567 这类状态转成可操作的提示。 */
function describeHttpError(status) {
  if (status === 401 || status === 403) {
    return `HTTP ${status}：需要登录或防盗链，请通过 headers 提供 Cookie / Referer / Authorization`
  }
  if (status === 509) {
    return 'HTTP 509：站点流量额度用尽（Cloudflare 带宽上限）；可降低线程数或稍后再试'
  }
  if (status === 520 || status === 521 || status === 522 || status === 524) {
    return `HTTP ${status}：Cloudflare 与源站之间的连接异常（不是本机问题），稍后重试或换镜像`
  }
  if (status === 530) return 'HTTP 530：源站 DNS 解析失败（Cloudflare），稍后重试或换镜像'
  if (status === 407) return 'HTTP 407：需要代理认证'
  if (status === 567) {
    return 'HTTP 567：站点安全策略拦截了本次请求（腾讯云 EdgeOne 等 WAF，本机访问已被限制）；'
      + '等拦截窗口过去再试、降低线程数，或换网络；浏览器能打开时把 Cookie 通过 headers 传入'
  }
  return `HTTP ${status}`
}

/** 响应类型是否为 HTML（WAF 拦截页、登录页、错误页都长这样）。 */
function isHtmlContentType(contentType) {
  const value = String(contentType ?? '').toLowerCase()
  return value.includes('text/html') || value.includes('application/xhtml+xml')
}

/**
 * 目标本身不是网页，却被回了一份 HTML：这是 WAF/登录页拦截，不是文件正文。
 * 宁可在这里判失败并说明原因，也不要把 7 KB 的拦截页改名成 .exe 交付。
 */
function looksLikeHtmlBlock(contentType, filename) {
  if (!isHtmlContentType(contentType)) return false
  return !/\.(?:html?|xhtml|htm)$/i.test(String(filename ?? ''))
}

/** 探测大小、Range 支持与文件名。 */
async function probeOnce(url, signal, extraHeaders = {}, dispatcher = undefined) {
  const headers = { 'accept-encoding': 'identity', 'user-agent': USER_AGENT, ...extraHeaders }
  let size = 0
  let ranges = false
  let filename = ''
  let etag = ''
  let lastModified = ''
  let contentType = ''
  let headOk = false
  let finalUrl = url
  try {
    const fetched = await fetchWithRedirects(url, { method: 'HEAD', headers, dispatcher }, signal)
    const head = fetched.response
    finalUrl = fetched.url
    fetched.release()
    if (head.ok) {
      headOk = true
      size = Number(head.headers.get('content-length') ?? 0) || 0
      ranges = (head.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes')
      filename = filenameFromDisposition(head.headers.get('content-disposition'))
      etag = head.headers.get('etag') ?? ''
      lastModified = head.headers.get('last-modified') ?? ''
      contentType = head.headers.get('content-type') ?? ''
    }
  } catch (error) {
    if (signal.aborted) throw error
  }
  if (size > 0 && ranges) return { size, ranges, filename, etag, lastModified, contentType, finalUrl }

  /**
   * 用 1 字节 Range 补齐 HEAD 给不出的信息（大小、Range 支持）。
   *
   * 这一请求失败不能直接判任务失败：HEAD 已经成功说明资源可访问，
   * 而「HEAD 200 + Range 405/403/501」是常见组合（拒绝 Range、防盗链只看 Range 请求）。
   * 这时按「不支持分片」单连接下载；真正的错误留给正文请求报。
   * 416 且总长 0 是合法的空文件，按空文件成功处理。
   */
  let fetched
  let response
  try {
    fetched = await fetchWithRedirects(url, { headers: { ...headers, range: 'bytes=0-0' }, dispatcher }, signal)
    response = fetched.response
    finalUrl = fetched.url
  } catch (error) {
    if (signal.aborted) throw error
    if (headOk) return { size, ranges: false, filename, etag, lastModified, contentType, finalUrl }
    throw error
  }
  if (response.status === 206) {
    const match = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')
    const total = match === null ? 0 : Number(match[1])
    if (total > 0) size = total
    ranges = true
    filename = filename || filenameFromDisposition(response.headers.get('content-disposition'))
    etag = etag || response.headers.get('etag') || ''
    lastModified = lastModified || response.headers.get('last-modified') || ''
    contentType = contentType || response.headers.get('content-type') || ''
    await response.body?.cancel().catch(() => {})
    fetched.release()
  } else if (response.status === 416) {
    // `bytes */0` 说明资源存在但长度为 0：合法的空文件，不是错误。
    const total = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')
    const length = total === null ? 0 : Number(total[1])
    fetched.release()
    if (length === 0) return { size: 0, ranges: false, filename, etag, lastModified, contentType, finalUrl }
    if (headOk) return { size, ranges: false, filename, etag, lastModified, contentType, finalUrl }
    // 抛错前主动取消正文：不 cancel 的话这条连接要等 GC/超时才回池。
    await response.body?.cancel().catch(() => {})
    throw httpErrorFor(response.status, response)
  } else if (response.ok) {
    if (size === 0) size = Number(response.headers.get('content-length') ?? 0) || 0
    filename = filename || filenameFromDisposition(response.headers.get('content-disposition'))
    contentType = contentType || response.headers.get('content-type') || ''
    await response.body?.cancel().catch(() => {})
    fetched.release()
  } else {
    fetched.release()
    // HEAD 已经拿到大小：降级成单连接，不要让一个 Range 探测的 405 杀掉整个任务。
    if (headOk) return { size, ranges: false, filename, etag, lastModified, contentType, finalUrl }
    // 抛错前主动取消正文：不 cancel 的话这条连接要等 GC/超时才回池。
    await response.body?.cancel().catch(() => {})
    throw httpErrorFor(response.status, response)
  }
  return { size, ranges: ranges && size > 0, filename, etag, lastModified, contentType, finalUrl }
}

/** 构造带 Retry-After 的 HTTP 错误，让退避逻辑能真正用上服务端的节奏要求。 */
function httpErrorFor(status, response, message = '') {
  const error = new Error(message !== '' ? message : describeHttpError(status))
  const retryAfter = retryAfterMsOf(response)
  if (retryAfter > 0) error.retryAfterMs = retryAfter
  return error
}

/** 带重试的探测；401/403 等不可重试错误直接抛出。 */
async function probe(url, signal, extraHeaders = {}, dispatcher = undefined) {
  let lastError
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await probeOnce(url, signal, extraHeaders, dispatcher)
    } catch (error) {
      lastError = error
      const status = /^HTTP (\d+)/.exec(error instanceof Error ? error.message : '')
      if (signal.aborted || !isRetryable(error, status === null ? undefined : Number(status[1]))) throw error
      if (attempt >= MAX_ATTEMPTS) break
      await sleep(retryDelay(attempt, error?.retryAfterMs ?? 0))
    }
  }
  throw lastError
}

/** 解析 GitHub Release 直链：owner/repo/releases/download/tag/file。 */
function parseGithubReleaseUrl(raw) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/(.+)\/([^/]+)$/.exec(raw)
  if (match === null) return null
  return {
    owner: match[1],
    repo: match[2],
    tag: decodeURIComponent(match[3]),
    asset: decodeURIComponent(match[4]),
  }
}

/** 把 GitHub Release 直链换成 API 资产链接，避免 github.com 被污染。 */
async function resolveGithubAsset(raw) {
  const parsed = parseGithubReleaseUrl(raw)
  if (parsed === null) return null
  const api = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases/tags/${encodeURIComponent(parsed.tag)}`
  const response = await undiciFetch(api, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
  const release = await response.json()
  const asset = Array.isArray(release.assets)
    ? release.assets.find((entry) => entry.name === parsed.asset)
    : undefined
  if (asset === undefined) throw new Error(`GitHub Release 中找不到资产：${parsed.asset}`)
  return {
    url: asset.url,
    headers: { accept: 'application/octet-stream' },
  }
}

/** 规范化用户提供的请求头：去掉换行、禁止覆盖 Range 等由下载器控制的头。 */
function sanitizeHeaders(input) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('headers 需为键值对象')
  const entries = Object.entries(input)
  if (entries.length > 30) throw new Error('headers 不能超过 30 项')
  const headers = {}
  let size = 0
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey).trim().toLowerCase()
    if (!/^[a-z0-9-]{1,64}$/.test(key)) throw new Error(`非法 header 名：${rawKey}`)
    if (FORBIDDEN_HEADERS.has(key)) continue
    const value = String(rawValue ?? '').replace(/[\r\n]/g, ' ').trim()
    if (value === '') continue
    size += key.length + value.length
    if (size > 8192) throw new Error('headers 过大（上限 8 KB）')
    headers[key] = value
  }
  return headers
}

/** 可重试的 HTTP 状态码或网络错误。 */
function isRetryable(error, status) {
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true
  if (error === undefined || error === null) return false
  if (error.name === 'AbortError') return false
  return error.name === 'TypeError'
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)
}

/** 从下载错误里取出 HTTP 状态码；网络错误返回 undefined。 */
function httpStatusOf(error) {
  const message = error instanceof Error ? error.message : ''
  const match = /^HTTP (\d+)/.exec(message)
  return match === null ? undefined : Number(match[1])
}

/** 指数退避，最多 8 秒；有 Retry-After 时优先使用。 */
function retryDelay(attempt, source) {
  const retryAfter = retryAfterMsOf(source)
  if (retryAfter > 0) return Math.min(30_000, retryAfter)
  return Math.min(8000, 500 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 250)
}

/**
 * 读取 Retry-After（秒或 HTTP 日期），返回毫秒；没有则返回 0。
 * 接受响应对象、Response.headers、或已经换算好的毫秒数，便于错误对象透传。
 */
function retryAfterMsOf(source) {
  if (typeof source === 'number') return Number.isFinite(source) && source > 0 ? source : 0
  if (source === null || source === undefined || typeof source !== 'object') return 0
  const headers = source.headers ?? source
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : undefined
  if (typeof raw !== 'string' || raw === '') return 0
  const seconds = Number(raw.trim())
  if (Number.isInteger(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(raw)
  if (Number.isNaN(date)) return 0
  return Math.max(0, date - Date.now())
}

/**
 * 跨源跳转时要剥掉会泄露凭据的请求头；同源原样保留。
 * 跟随重定向与「直接复用跳转后的最终地址」两处都必须用同一套规则。
 */
function headersForRedirect(headers, fromUrl, toUrl) {
  const next = { ...(headers ?? {}) }
  let sameOrigin = true
  try {
    sameOrigin = new URL(fromUrl).origin === new URL(toUrl).origin
  } catch {
    sameOrigin = true
  }
  if (sameOrigin) return next
  for (const key of Object.keys(next)) {
    if (['cookie', 'authorization', 'proxy-authorization'].includes(key.toLowerCase())) delete next[key]
  }
  return next
}

/**
 * 从签名直链里读出过期时间（毫秒时间戳）；读不到返回 0。
 * GitHub 资产跳转到的 release-assets 链接带 `se`（ISO 时间），S3 风格链接带 `Expires`。
 */
function signedUrlExpiry(raw) {
  let url
  try {
    url = raw instanceof URL ? raw : new URL(String(raw ?? ''))
  } catch {
    return 0
  }
  const se = url.searchParams.get('se')
  if (se !== null && se !== '') {
    const parsed = Date.parse(se)
    if (!Number.isNaN(parsed)) return parsed
  }
  const expires = url.searchParams.get('Expires')
  if (expires !== null && /^\d+$/.test(expires)) {
    const seconds = Number(expires)
    // 小于 10 亿说明是「多少秒后过期」，否则按绝对秒级时间戳处理。
    return seconds < 1e9 ? Date.now() + seconds * 1000 : seconds * 1000
  }
  return 0
}

/** 跟随重定向，并在跨源跳转时剥离敏感请求头；只给“拿到响应头”设超时。 */
async function fetchWithRedirects(url, init, signal, maxHops = 5) {
  let current = new URL(url)
  let headers = { ...(init.headers ?? {}) }
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const controller = new AbortController()
    const forward = () => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', forward, { once: true })
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response
    try {
      response = await undiciFetch(current, { ...init, headers, redirect: 'manual', signal: controller.signal })
    } catch (error) {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
      throw error
    }
    clearTimeout(timer)
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, release: () => signal.removeEventListener('abort', forward), url: current.href }
    }
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    signal.removeEventListener('abort', forward)
    if (location === null) throw new Error(`HTTP ${response.status}`)
    const next = new URL(location, current)
    headers = headersForRedirect(headers, current.href, next.href)
    current = next
  }
  throw new Error('重定向次数过多')
}

export {
  USER_AGENT,
  MAX_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  RETRYABLE_STATUS,
  FORBIDDEN_HEADERS,
  parseHttpUrl,
  fingerprintChange,
  ifRangeValue,
  strongEtag,
  describeHttpError,
  httpErrorFor,
  isHtmlContentType,
  looksLikeHtmlBlock,
  probeOnce,
  probe,
  parseGithubReleaseUrl,
  resolveGithubAsset,
  sanitizeHeaders,
  isRetryable,
  httpStatusOf,
  retryDelay,
  retryAfterMsOf,
  headersForRedirect,
  signedUrlExpiry,
  fetchWithRedirects,
}
