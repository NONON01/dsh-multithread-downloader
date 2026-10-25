/**
 * 多线程下载器 —— Host 半边。
 *
 * 以 HTTP Range 分片并发下载到本地文件，向 Web GUI 暴露 /api/mtd/* 路由，
 * 并向 agent 注册 `downloader` 工具。UI 与工具调用同一套 Downloader 方法。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, open, readdir, rename, statfs, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const API_PREFIX = '/api/mtd'
const MAX_THREADS = 16
const MAX_TASKS = 100
const MIN_CHUNK_BYTES = 512 * 1024
/** 超过该大小的任务才记录并返回进度采样历史（面板据此绘制曲线）。 */
const DEFAULT_LARGE_FILE_MB = 16
const DEFAULT_MIN_THREAD_MB = 4
const HISTORY_LIMIT = 240
const MAX_ATTEMPTS = 4
const REQUEST_TIMEOUT_MS = 30_000
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const FORBIDDEN_HEADERS = new Set(['range', 'content-length', 'host', 'connection', 'accept-encoding'])
const DISK_MARGIN_BYTES = 32 * 1024 * 1024
const USER_AGENT = 'DSH-MultithreadDownloader/1.0'
/** 随插件分发的 Windows 原生目录选择器。 */
const NATIVE_PICKER = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'picker.exe')
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

/** 当前 profile 目录：优先环境变量，退回 ~/.dsh/profiles/<name>。 */
function resolveProfileDirectory() {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const name = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : 'desktop'
  return join(homedir(), '.dsh', 'profiles', name)
}

/** 展开 Windows 注册表里的 %VAR%，保持原样表示无法展开。 */
function expandWindowsEnvironment(value) {
  return value.replace(/%([^%]+)%/g, (match, name) => {
    const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    return key === undefined ? match : process.env[key]
  })
}

/** Windows 的“下载” Known Folder，支持被重定向到 OneDrive/D: 等位置。 */
function windowsDownloadDirectory() {
  try {
    const result = spawnSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        '/v',
        '{374DE290-123F-4565-9164-39C4925E467B}',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 1500 },
    )
    if (result.status !== 0 || typeof result.stdout !== 'string') return ''
    const match = /REG_\w+\s+(.+?)\r?$/m.exec(result.stdout)
    if (match === null) return ''
    const expanded = expandWindowsEnvironment(match[1].trim())
    return isAbsolute(expanded) ? expanded : ''
  } catch {
    return ''
  }
}

/** Linux 的 XDG 下载目录（~/.config/user-dirs.dirs）。 */
function xdgDownloadDirectory(home) {
  try {
    const text = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8')
    const match = /^XDG_DOWNLOAD_DIR="(.+)"$/m.exec(text)
    if (match === null) return ''
    const value = match[1].replace(/^\$HOME/, home)
    return isAbsolute(value) ? value : ''
  } catch {
    return ''
  }
}

/** 尝试拿到 Electron 的 dialog；非 Electron Host 返回 null。 */
async function electronDialog() {
  if (!process.versions.electron) return null
  try {
    const electron = await import('electron')
    const dialog = electron.dialog ?? electron.default?.dialog
    return dialog !== undefined && dialog !== null && typeof dialog.showOpenDialog === 'function' ? dialog : null
  } catch {
    return null
  }
}

/** 调用随包分发的 Windows 原生选择器（IFileOpenDialog）。 */
function pickWindowsHelper(title, initial) {
  return new Promise((resolve, reject) => {
    const args = ['--title', title]
    if (typeof initial === 'string' && initial.trim() !== '') args.push('--initial', initial.trim())
    const child = spawn(NATIVE_PICKER, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim() === '' ? null : stdout.trim())
        return
      }
      if (code === 2) {
        resolve(null)
        return
      }
      reject(new Error(stderr.trim() !== '' ? stderr.trim() : `native picker exited ${code}`))
    })
  })
}

/** 运行一个外部选择器进程；取消返回 null，启动失败抛错。 */
function runPickerProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        const picked = stdout.trim()
        resolve(picked === '' ? null : picked)
        return
      }
      if (code === 1) {
        resolve(null)
        return
      }
      reject(new Error(stderr.trim() !== '' ? stderr.trim() : `${command} exited ${code}`))
    })
  })
}

/** macOS 原生目录选择。 */
function pickMacDirectory(title) {
  const literal = JSON.stringify(title)
  return runPickerProcess('osascript', ['-e', `POSIX path of (choose folder with prompt ${literal})`])
}

/** Linux 原生目录选择：zenity 优先，其次 kdialog。 */
async function pickLinuxDirectory(title) {
  try {
    return await runPickerProcess('zenity', ['--file-selection', '--directory', '--title', title])
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return runPickerProcess('kdialog', ['--getexistingdirectory', process.env.HOME ?? '/', '--title', title])
}

/** 原生目录选择：Electron 对话框优先，其次随包 Windows 选择器。 */
async function pickNativeDirectory(title, initial) {
  const dialog = await electronDialog()
  if (dialog !== null) {
    const result = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }
  if (process.platform === 'win32' && existsSync(NATIVE_PICKER)) return pickWindowsHelper(title, initial)
  if (process.platform === 'darwin') return pickMacDirectory(title)
  if (process.platform === 'linux') return pickLinuxDirectory(title)
  return undefined
}

/** 列出一层目录，供面板的目录浏览器使用。 */
async function browseDirectory(input) {
  const home = homedir()
  const target = typeof input === 'string' && input.trim() !== '' ? resolve(input.trim()) : home
  const dirents = await readdir(target, { withFileTypes: true })
  const entries = dirents
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(target, entry.name),
      hidden: entry.name.startsWith('.'),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const truncated = entries.length > 500
  const root = parse(target).root
  const crumbs = [{ name: root.endsWith(sep) ? root.slice(0, -1) || root : root, path: root }]
  let current = root
  for (const part of target.slice(root.length).split(sep).filter((segment) => segment !== '')) {
    current = join(current, part)
    crumbs.push({ name: part, path: current })
  }
  return {
    path: target,
    home,
    crumbs,
    entries: truncated ? entries.slice(0, 500) : entries,
    truncated,
  }
}

/** 解析默认下载目录：配置 > Known Folder > 用户主目录/Downloads。 */
function defaultDownloadDirectory() {
  const home = homedir()
  if (process.platform === 'win32') {
    const known = windowsDownloadDirectory()
    if (known !== '') return known
  } else if (process.platform === 'linux') {
    const xdg = xdgDownloadDirectory(home)
    if (xdg !== '') return xdg
  }
  return join(home, 'Downloads')
}

/** 读取持久化的阈值设置；损坏或缺失时返回空对象。 */
function readSettingsFile(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const settings = {}
    const bytes = Number(data.largeFileBytes)
    const minThreadBytes = Number(data.minThreadBytes)
    const minThreadMb = Number(data.minThreadMb)
    if (Number.isFinite(bytes)) settings.largeFileBytes = bytes
    if (Number.isFinite(minThreadBytes)) settings.minThreadBytes = minThreadBytes
    else if (Number.isFinite(minThreadMb)) settings.minThreadMb = minThreadMb
    if (typeof data.minThreadEnabled === 'boolean') settings.minThreadEnabled = data.minThreadEnabled
    if (typeof data.silentEnabled === 'boolean') settings.silentEnabled = data.silentEnabled
    if (typeof data.agentAutonomy === 'boolean') settings.agentAutonomy = data.agentAutonomy
    if (Number.isFinite(data.rateLimitBytes)) settings.rateLimitBytes = data.rateLimitBytes
    if (Number.isFinite(data.maxConcurrent)) settings.maxConcurrent = data.maxConcurrent
    return settings
  } catch {
    return {}
  }
}

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

/** 从 Content-Disposition 取文件名（兼容 filename*）。 */
function filenameFromDisposition(value) {
  if (typeof value !== 'string' || value === '') return ''
  const extended = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value)
  if (extended !== null) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''))
    } catch {
      /* 忽略损坏的 filename* */
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(value) ?? /filename\s*=\s*([^;]+)/i.exec(value)
  return plain === null ? '' : plain[1].trim()
}

/** 去掉 Windows 不允许的字符，避免路径逃逸。 */
function sanitizeFilename(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 180)
  if (cleaned === '') return ''
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) return `_${cleaned}`
  return cleaned
}

/** 从 URL 推断文件名。 */
function filenameFromUrl(url) {
  const raw = decodeURIComponent(url.pathname.split('/').pop() ?? '')
  const cleaned = sanitizeFilename(raw)
  return cleaned === '' ? 'download.bin' : cleaned
}

/** 目标目录里重名时追加 (n)。 */
async function uniqueName(dir, name, reserved) {
  const extension = extname(name)
  const stem = extension === '' ? name : name.slice(0, -extension.length)
  let candidate = name
  for (let index = 1; index < 1000; index += 1) {
    const target = join(dir, candidate)
    if (!(reserved?.has(target) ?? false)) {
      try {
        await open(target, 'r').then((handle) => handle.close())
      } catch (error) {
        if (error?.code === 'ENOENT') return candidate
        throw error
      }
    }
    candidate = `${stem} (${index})${extension}`
  }
  return `${stem}-${Date.now()}${extension}`
}

/** 把 401/403/407 这类状态转成可操作的提示。 */
function describeHttpError(status) {
  if (status === 401 || status === 403) {
    return `HTTP ${status}：需要登录或防盗链，请通过 headers 提供 Cookie / Referer / Authorization`
  }
  if (status === 407) return 'HTTP 407：需要代理认证'
  return `HTTP ${status}`
}

/** 探测大小、Range 支持与文件名。 */
async function probeOnce(url, signal, extraHeaders = {}) {
  const headers = { 'accept-encoding': 'identity', 'user-agent': USER_AGENT, ...extraHeaders }
  let size = 0
  let ranges = false
  let filename = ''
  let etag = ''
  let lastModified = ''
  try {
    const fetched = await fetchWithRedirects(url, { method: 'HEAD', headers }, signal)
    const head = fetched.response
    fetched.release()
    if (head.ok) {
      size = Number(head.headers.get('content-length') ?? 0) || 0
      ranges = (head.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes')
      filename = filenameFromDisposition(head.headers.get('content-disposition'))
      etag = head.headers.get('etag') ?? ''
      lastModified = head.headers.get('last-modified') ?? ''
    }
  } catch (error) {
    if (signal.aborted) throw error
  }
  if (size > 0 && ranges) return { size, ranges, filename, etag, lastModified }

  const fetched = await fetchWithRedirects(url, { headers: { ...headers, range: 'bytes=0-0' } }, signal)
  const response = fetched.response
  if (response.status === 206) {
    const match = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')
    const total = match === null ? 0 : Number(match[1])
    if (total > 0) size = total
    ranges = true
    filename = filename || filenameFromDisposition(response.headers.get('content-disposition'))
    etag = etag || response.headers.get('etag') || ''
    lastModified = lastModified || response.headers.get('last-modified') || ''
    await response.body?.cancel().catch(() => {})
    fetched.release()
  } else if (response.ok) {
    if (size === 0) size = Number(response.headers.get('content-length') ?? 0) || 0
    filename = filename || filenameFromDisposition(response.headers.get('content-disposition'))
    await response.body?.cancel().catch(() => {})
    fetched.release()
  } else {
    fetched.release()
    throw new Error(describeHttpError(response.status))
  }
  return { size, ranges: ranges && size > 0, filename, etag, lastModified }
}

/** 带重试的探测；401/403 等不可重试错误直接抛出。 */
async function probe(url, signal, extraHeaders = {}) {
  let lastError
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await probeOnce(url, signal, extraHeaders)
    } catch (error) {
      lastError = error
      const status = /^HTTP (\d+)/.exec(error instanceof Error ? error.message : '')
      if (signal.aborted || !isRetryable(error, status === null ? undefined : Number(status[1]))) throw error
      if (attempt >= MAX_ATTEMPTS) break
      await sleep(retryDelay(attempt))
    }
  }
  throw lastError
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

/** 指数退避，最多 8 秒；有 Retry-After 时优先使用。 */
function retryDelay(attempt, response) {
  const retryAfter = response?.headers?.get('retry-after') ?? ''
  if (/^\d+$/.test(retryAfter)) return Math.min(30_000, Number(retryAfter) * 1000)
  return Math.min(8000, 500 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 250)
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
      response = await fetch(current, { ...init, headers, redirect: 'manual', signal: controller.signal })
    } catch (error) {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
      throw error
    }
    clearTimeout(timer)
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, release: () => signal.removeEventListener('abort', forward) }
    }
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    signal.removeEventListener('abort', forward)
    if (location === null) throw new Error(`HTTP ${response.status}`)
    const next = new URL(location, current)
    if (next.origin !== current.origin) {
      headers = { ...headers }
      for (const key of Object.keys(headers)) {
        if (['cookie', 'authorization', 'proxy-authorization'].includes(key.toLowerCase())) delete headers[key]
      }
    }
    current = next
  }
  throw new Error('重定向次数过多')
}

/** 流式计算文件 SHA-256。 */
async function fileSha256(path) {
  const handle = await open(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/** 目标目录可用空间；不支持 statfs 时返回 null。 */
async function freeDiskBytes(directory) {
  try {
    const info = await statfs(directory)
    const blockSize = Number(info.bsize)
    const available = Number(info.bavail)
    if (!Number.isFinite(blockSize) || !Number.isFinite(available)) return null
    return blockSize * available
  } catch {
    return null
  }
}

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

/** 一个下载任务。 */
class DownloadTask {
  constructor(manager, input) {
    this.manager = manager
    this.id = input.id
    this.urls = Array.isArray(input.urls) && input.urls.length > 0 ? input.urls : [input.url]
    this.url = this.urls[0]
    this.urlIndex = 0
    this.headers = input.headers ?? {}
    this.sha256 = typeof input.sha256 === 'string' ? input.sha256.toLowerCase() : ''
    this.dir = input.dir
    this.requestedName = input.filename
    this.threads = input.threads
    this.singleThread = input.singleThread
    this.origin = input.origin === 'user' ? 'user' : 'agent'
    this.etag = ''
    this.lastModified = ''
    this.rangeFallback = false
    this.resetFile = false
    this.status = 'queued'
    this.error = ''
    this.filename = input.filename
    this.path = ''
    this.partPath = ''
    this.totalBytes = 0
    this.receivedBytes = 0
    this.speed = 0
    this.progress = 0
    this.createdAt = Date.now()
    this.startedAt = 0
    this.finishedAt = 0
    this.chunks = []
    this.handle = null
    this.abort = new AbortController()
    this.sampler = null
    this.lastSample = 0
    this.lastSampleAt = 0
    this.history = []
  }

  get active() {
    return this.status === 'downloading' || this.status === 'probing'
  }

  snapshot(options = {}) {
    const snapshot = {
      id: this.id,
      url: this.url,
      dir: this.dir,
      filename: this.filename,
      path: this.path,
      status: this.status,
      error: this.error,
      totalBytes: this.totalBytes,
      receivedBytes: this.receivedBytes,
      progress: this.totalBytes > 0 ? Math.min(1, this.receivedBytes / this.totalBytes) : 0,
      speed: this.speed,
      threads: this.chunks.length > 0 ? this.chunks.length : this.threads,
      origin: this.origin,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    }
    // 仅大文件回传采样历史，避免小任务的轮询负载。
    if (options.history === true && this.manager.shouldDisplay(this) && this.history.length > 0) {
      snapshot.history = this.history.slice()
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
      sha256: this.sha256,
      origin: this.origin,
      threads: this.threads,
      singleThread: this.singleThread,
      createdAt: this.createdAt,
    }
  }

  recordHistory(now) {
    if (!this.manager.shouldDisplay(this)) return
    const elapsed = Math.max(0, Math.floor((now - this.startedAt) / 1000))
    const last = this.history[this.history.length - 1]
    if (last !== undefined && last.t >= elapsed) return
    this.history.push({
      t: elapsed,
      p: Math.round(this.progress * 1000) / 1000,
      s: this.speed,
    })
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT)
  }

  startSampler() {
    this.stopSampler()
    this.lastSample = this.receivedBytes
    this.lastSampleAt = Date.now()
    this.sampler = setInterval(() => {
      const now = Date.now()
      const elapsed = Math.max(1, now - this.lastSampleAt) / 1000
      const bytes = this.receivedBytes
      const delta = Math.max(0, bytes - this.lastSample)
      this.speed = Math.round(delta / elapsed)
      this.lastSample = bytes
      this.lastSampleAt = now
      this.progress = this.totalBytes > 0 ? Math.min(1, bytes / this.totalBytes) : 0
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
  }

  begin() {
    if (this.status !== 'queued') return
    this.status = 'probing'
    this.run().catch((error) => this.fail(error))
  }

  async probeAny() {
    let lastError
    for (let index = 0; index < this.urls.length; index += 1) {
      try {
        const result = await probe(this.urls[index], this.abort.signal, this.headers)
        this.url = this.urls[index]
        this.urlIndex = index
        return result
      } catch (error) {
        lastError = error
        if (this.abort.signal.aborted) throw error
      }
    }
    throw lastError
  }

  async run() {
    const result = await this.probeAny()
    if (this.status !== 'probing') return
    this.totalBytes = result.size
    this.etag = result.etag ?? ''
    this.lastModified = result.lastModified ?? ''
    const chosen = this.requestedName !== '' ? this.requestedName : (result.filename || filenameFromUrl(new URL(this.url)))
    const safeName = sanitizeFilename(chosen) || `download-${this.id}.bin`
    if (this.path === '') {
      await mkdir(this.dir, { recursive: true })
      this.filename = await this.manager.reserveName(this.dir, safeName)
      this.path = join(this.dir, this.filename)
      this.partPath = `${this.path}.mtd-part`
    }
    await mkdir(this.dir, { recursive: true })
    if (this.totalBytes > 0) {
      const free = await freeDiskBytes(this.dir)
      if (free !== null && free < this.totalBytes + DISK_MARGIN_BYTES) {
        throw new Error(`磁盘空间不足：需要 ${this.totalBytes + DISK_MARGIN_BYTES} 字节，可用 ${free} 字节`)
      }
    }
    this.handle = await open(this.partPath, 'w+')
    if (this.totalBytes > 0) await this.handle.truncate(this.totalBytes)
    this.chunks = this.buildChunks(result)
    this.status = 'downloading'
    this.startedAt = this.startedAt || Date.now()
    if (this.manager.shouldDisplay(this) && this.history.length === 0) {
      this.history = [{ t: 0, p: 0, s: 0 }]
    }
    await this.runChunks()
  }

  buildChunks(result) {
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
    const count = Math.max(1, Math.min(this.threads, Math.floor(this.totalBytes / MIN_CHUNK_BYTES) || 1))
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

  async runChunk(chunk) {
    let attempts = 0
    while (this.status === 'downloading') {
      const position = chunk.start + chunk.cursor
      if (chunk.end >= 0 && position > chunk.end) return
      let release = null
      try {
        const headers = { 'accept-encoding': 'identity', 'user-agent': USER_AGENT, ...this.headers }
        if (chunk.end >= 0) headers.range = `bytes=${position}-${chunk.end}`
        const url = this.urls[this.urlIndex % this.urls.length]
        const fetched = await fetchWithRedirects(url, { headers }, this.abort.signal)
        release = fetched.release
        const response = fetched.response
        if (response.status === 401 || response.status === 403 || response.status === 407) {
          await response.body?.cancel().catch(() => {})
          throw new Error(describeHttpError(response.status))
        }
        if (response.status === 416 && chunk.end >= 0) return
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        if (chunk.end >= 0 && response.status === 200) {
          await response.body?.cancel().catch(() => {})
          const ignored = new Error('服务器忽略了 Range 请求')
          ignored.code = 'RANGE_IGNORED'
          throw ignored
        }
        if (chunk.end >= 0 && response.status !== 206) throw new Error(`HTTP ${response.status}`)
        if (response.body === null) throw new Error('响应没有正文')
        const reader = response.body.getReader()
        let cursor = position
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (this.status !== 'downloading') {
            await reader.cancel().catch(() => {})
            return
          }
          if (this.handle === null) throw new Error('文件句柄已关闭')
          await this.manager.limiter.take(value.length)
          await this.handle.write(value, 0, value.length, cursor)
          cursor += value.length
          chunk.cursor = cursor - chunk.start
          this.receivedBytes += value.length
        }
        if (this.status !== 'downloading') return
        if (chunk.end < 0 || cursor > chunk.end) return
        throw new Error('连接提前结束')
      } catch (error) {
        if (this.status !== 'downloading' || this.abort.signal.aborted) return
        const statusMatch = /^HTTP (\d+)/.exec(error instanceof Error ? error.message : '')
        const status = statusMatch === null ? undefined : Number(statusMatch[1])
        const timedOut = error?.name === 'AbortError' && !this.abort.signal.aborted
        if (!timedOut && !isRetryable(error, status)) throw error
        attempts += 1
        if (attempts >= MAX_ATTEMPTS) throw error
        if (this.urls.length > 1) this.urlIndex = (this.urlIndex + 1) % this.urls.length
        await sleep(retryDelay(attempts))
      } finally {
        if (release !== null) release()
      }
    }
  }

  /** 续传前重新探测；远端文件变了就放弃旧分片，从头开始。 */
  async revalidate() {
    let fresh
    try {
      fresh = await probe(this.url, this.abort.signal, this.headers)
    } catch {
      return
    }
    const sizeChanged = fresh.size > 0 && this.totalBytes > 0 && fresh.size !== this.totalBytes
    const etagChanged = this.etag !== '' && fresh.etag !== '' && this.etag !== fresh.etag
    const modifiedChanged = this.lastModified !== '' && fresh.lastModified !== '' && this.lastModified !== fresh.lastModified
    if (!sizeChanged && !etagChanged && !modifiedChanged) return
    this.totalBytes = fresh.size || this.totalBytes
    this.etag = fresh.etag || this.etag
    this.lastModified = fresh.lastModified || this.lastModified
    this.chunks = this.buildChunks(fresh)
    this.receivedBytes = 0
    this.progress = 0
    this.history = []
    if (this.manager.shouldDisplay(this)) this.history = [{ t: 0, p: 0, s: 0 }]
    this.resetFile = true
  }

  /** 服务器中途忽略 Range：丢掉分片，改用单连接整段重下。 */
  async restartSingleStream() {
    this.rangeFallback = true
    this.chunks = [{ start: 0, end: -1, cursor: 0, total: this.totalBytes }]
    this.receivedBytes = 0
    this.progress = 0
    this.history = []
    if (this.manager.shouldDisplay(this)) this.history = [{ t: 0, p: 0, s: 0 }]
    this.closeHandle()
    this.resetFile = true
    await this.runChunks()
  }

  async runChunks() {
    this.abort = new AbortController()
    this.status = 'downloading'
    // 续传前核对远端大小 / ETag / Last-Modified，变化则从头下载，避免拼出混合内容。
    if (this.chunks.some((chunk) => chunk.cursor > 0)) await this.revalidate()
    if (this.status !== 'downloading') return
    if (this.handle === null) this.handle = await open(this.partPath, 'r+')
    if (this.resetFile) {
      const truncateTo = this.chunks.length === 1 && this.chunks[0].end < 0 ? 0 : this.totalBytes
      await this.handle.truncate(truncateTo)
      this.resetFile = false
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
    const settled = await Promise.allSettled(this.chunks.map((chunk) => this.runChunk(chunk)))
    if (this.status !== 'downloading') return
    const failed = settled.find((entry) => entry.status === 'rejected')
    if (failed !== undefined) {
      if (failed.reason?.code === 'RANGE_IGNORED' && !this.rangeFallback) {
        await this.restartSingleStream()
        return
      }
      this.fail(failed.reason)
      return
    }
    await this.finalize()
  }

  async finalize() {
    if (this.handle === null) throw new Error('文件句柄已关闭')
    const info = await this.handle.stat()
    await this.handle.close()
    this.handle = null
    if (this.totalBytes > 0 && info.size !== this.totalBytes) {
      throw new Error(`文件大小不符：期望 ${this.totalBytes}，实际 ${info.size}`)
    }
    if (this.sha256 !== '') {
      const actual = await fileSha256(this.partPath)
      if (actual !== this.sha256) {
        throw new Error(`SHA-256 不匹配：期望 ${this.sha256}，实际 ${actual}`)
      }
    }
    await rename(this.partPath, this.path)
    this.manager.releaseName(this.path)
    this.totalBytes = info.size
    this.receivedBytes = info.size
    this.progress = 1
    this.status = 'completed'
    this.finishedAt = Date.now()
    this.stopSampler()
    if (this.manager.shouldDisplay(this)) {
      const elapsed = Math.max(1, Math.floor((this.finishedAt - this.startedAt) / 1000))
      const last = this.history[this.history.length - 1]
      if (last === undefined || last.t < elapsed) this.history.push({ t: elapsed, p: 1, s: 0 })
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
    if (!this.active) return
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
          const handle = await open(this.partPath, 'r+')
          await handle.truncate(this.totalBytes)
          await handle.close()
          this.chunks = this.chunks.map((chunk) => ({ ...chunk, cursor: 0 }))
          this.receivedBytes = 0
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
    this.manager.releaseName(this.path)
    this.manager.persistTasks()
    this.manager.pump()
  }

  async remove() {
    await this.cancel()
    this.closeHandle()
    if (this.partPath !== '') await unlink(this.partPath).catch(() => {})
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
    this.maxConcurrent = options.maxConcurrent
    this.largeFileBytes = options.largeFileMb * 1024 * 1024
    this.largeFileMb = Math.round(this.largeFileBytes / (1024 * 1024))
    this.minThreadMb = options.minThreadMb
    this.minThreadBytes = options.minThreadMb * 1024 * 1024
    this.settingsPath = options.settingsPath
    this.settingsPersistError = ''
    this.minThreadEnabled = options.minThreadEnabled
    this.agentAutonomy = options.agentAutonomy
    this.silentEnabled = options.silentEnabled
    this.rateLimitBytes = options.rateLimitBytes ?? 0
    this.limiter = new RateLimiter(this.rateLimitBytes)
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
    let top = null
    const tasks = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'queued' && task.status !== 'probing' && task.status !== 'downloading' && task.status !== 'paused') continue
      if (!this.shouldDisplay(task)) continue
      const entry = {
        id: task.id,
        filename: task.filename,
        url: task.url,
        status: task.status,
        progress: task.totalBytes > 0 ? Math.min(1, task.receivedBytes / task.totalBytes) : 0,
        speed: task.speed,
        totalBytes: task.totalBytes,
        receivedBytes: task.receivedBytes,
      }
      tasks.push(entry)
      unfinished += 1
      totalBytes += task.totalBytes
      receivedBytes += task.receivedBytes
      if (task.status === 'downloading') speed += task.speed
      if (top === null || (top.status !== 'downloading' && task.status === 'downloading')) top = entry
    }
    return { unfinished, active: this.activeCount(), totalBytes, receivedBytes, speed, top, tasks, largeFileBytes: this.largeFileBytes, largeFileMb: this.largeFileMb, minThreadBytes: this.minThreadBytes, minThreadMb: this.minThreadMb, minThreadEnabled: this.minThreadEnabled, agentAutonomy: this.agentAutonomy, silentEnabled: this.silentEnabled }
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
    this.largeFileBytes = bytes
    this.largeFileMb = Math.round(bytes / (1024 * 1024))
    this.minThreadBytes = minThreadBytes
    this.minThreadMb = Math.round(minThreadBytes / (1024 * 1024))
    if (input.minThreadEnabled !== undefined) this.minThreadEnabled = Boolean(input.minThreadEnabled)
    if (input.agentAutonomy !== undefined) this.agentAutonomy = Boolean(input.agentAutonomy)
    if (input.silentEnabled !== undefined) this.silentEnabled = Boolean(input.silentEnabled)
    if (input.rateLimitBytes !== undefined) {
      const rate = Math.round(Number(input.rateLimitBytes))
      if (!Number.isFinite(rate) || rate < 0 || rate > 1024 * 1024 * 1024) throw new Error('限速需为 0..1 GB/s')
      this.rateLimitBytes = rate
      this.limiter.setRate(rate)
    }
    if (input.maxConcurrent !== undefined) {
      const concurrency = Math.round(Number(input.maxConcurrent))
      if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('同时任务数需为 1..8')
      this.maxConcurrent = concurrency
      this.pump()
    }
    const persisted = this.persistSettings()
    return {
      largeFileBytes: bytes,
      largeFileMb: this.largeFileMb,
      minThreadBytes,
      minThreadMb: this.minThreadMb,
      minThreadEnabled: this.minThreadEnabled,
      agentAutonomy: this.agentAutonomy,
      silentEnabled: this.silentEnabled,
      rateLimitBytes: this.rateLimitBytes,
      maxConcurrent: this.maxConcurrent,
      persisted,
      ...this.settingsPersistError === '' ? {} : { persistError: this.settingsPersistError },
    }
  }

  /** 把当前阈值写回 profile 下的本地文件；失败只记录原因，不影响内存设置。 */
  persistSettings() {
    if (typeof this.settingsPath !== 'string' || this.settingsPath === '') return false
    try {
      const payload = JSON.stringify({
        version: 7,
        largeFileBytes: this.largeFileBytes,
        minThreadBytes: this.minThreadBytes,
        minThreadEnabled: this.minThreadEnabled,
        agentAutonomy: this.agentAutonomy,
        silentEnabled: this.silentEnabled,
        rateLimitBytes: this.rateLimitBytes,
        maxConcurrent: this.maxConcurrent,
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
          sha256: record.sha256 ?? '',
        })
        task.requestedName = typeof record.requestedName === 'string' ? record.requestedName : ''
        task.path = record.path
        task.partPath = record.partPath
        task.totalBytes = Number(record.totalBytes) || 0
        task.etag = record.etag ?? ''
        task.lastModified = record.lastModified ?? ''
        task.createdAt = Number(record.createdAt) || Date.now()
        task.chunks = Array.isArray(record.chunks) ? record.chunks : []
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

  async add(request) {
    if (this.tasks.size >= MAX_TASKS) throw new Error(`任务数已达上限 ${MAX_TASKS}，请先移除旧任务`)
    const urls = []
    const candidates = Array.isArray(request.urls) && request.urls.length > 0 ? request.urls : [request.url]
    if (Array.isArray(request.mirrors)) candidates.push(...request.mirrors)
    for (const candidate of candidates) {
      const parsed = parseHttpUrl(candidate)
      if (!urls.includes(parsed.toString())) urls.push(parsed.toString())
    }
    const sha256 = typeof request.sha256 === 'string' ? request.sha256.trim().toLowerCase() : ''
    if (sha256 !== '' && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('sha256 需为 64 位十六进制')
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
      singleThread: request.singleThread === undefined ? undefined : Boolean(request.singleThread),
      origin: request.origin === 'user' ? 'user' : 'agent',
      headers: sanitizeHeaders(request.headers),
      sha256,
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
        task.pause()
        return { task: task.snapshot() }
      case 'resume':
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
      this.tasks.delete(task.id)
      removed += 1
    }
    this.persistTasks()
    return removed
  }

  dispose() {
    this.persistTasks()
    if (this.persistTimer !== null) clearInterval(this.persistTimer)
    for (const task of this.tasks.values()) task.dispose()
    this.tasks.clear()
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
    sha256: { type: 'string', description: '完成后校验的 SHA-256（64 位十六进制）。' },
    id: { type: 'string', description: 'pause/resume/cancel/remove 时的任务 id。' },
    directory: { type: 'string', description: '保存目录，省略则用插件默认目录。' },
    filename: { type: 'string', description: '保存文件名，省略则由响应头或 URL 推断。' },
    threads: { type: 'integer', description: '分片并发数 1..16，省略用默认值。' },
    singleThread: { type: 'boolean', description: 'true 强制单连接，false 强制分片；省略时普通模式按单线程阈值，Agent 自主模式下默认分片。' },
    limit: { type: 'integer', description: 'list 时最多返回多少条（1..100，默认 20）。' },
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
    progress: { type: 'number' },
    speed: { type: 'integer' },
    threads: { type: 'integer' },
    createdAt: { type: 'integer' },
    startedAt: { type: 'integer' },
    finishedAt: { type: 'integer' },
    visibleInUi: { type: 'boolean' },
    origin: { type: 'string' },
  },
}

function makeTool(manager) {
  return {
    name: 'downloader',
    description:
      '多线程（HTTP Range 分片）文件下载器，下载到 dsh Host 本机磁盘。action=add 需要 url，可选 directory/filename/threads；action=list 返回任务与进度（limit 默认 20，visibleInUi 表示是否在面板显示）；用返回的 id 执行 pause/resume/cancel/remove；clean 清空已结束任务。下载在 Host 后台继续，不需要等待；达到静默阈值（或开关关闭）的任务额外返回 history；小于阈值且开关开启时任务静默完成，不出现在面板和对话条，但工具 list 仍可见。可用 singleThread 指定单连接/分片；用户手动下载始终显示并多线程；其余下载由 Agent 控制或受阈值约束。',
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
          removed: { type: 'string' },
          cleaned: { type: 'integer' },
          directory: { type: 'string' },
          defaultThreads: { type: 'integer' },
          agentAutonomy: { type: 'boolean' },
          silentEnabled: { type: 'boolean' },
          largeFileMb: { type: 'integer' },
          minThreadMb: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => toolText(JSON.stringify(value, null, 2)),
    },
    async execute(args) {
      const input = args ?? {}
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
            const all = manager.list()
            return {
              ok: true,
              action: 'list',
              tasks: all.slice(0, limit).map((task) => ({ ...task, visibleInUi: manager.shouldDisplay(task) })),
              total: all.length,
              directory: manager.root,
              defaultThreads: manager.defaultThreads,
              agentAutonomy: manager.agentAutonomy,
              silentEnabled: manager.silentEnabled,
              largeFileMb: manager.largeFileMb,
              minThreadMb: manager.minThreadMb,
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
          maxConcurrent: manager.maxConcurrent,
          active: manager.activeCount(),
          largeFileBytes: manager.largeFileBytes,
          largeFileMb: manager.largeFileMb,
          minThreadBytes: manager.minThreadBytes,
          minThreadMb: manager.minThreadMb,
          minThreadEnabled: manager.minThreadEnabled,
          agentAutonomy: manager.agentAutonomy,
          silentEnabled: manager.silentEnabled,
          rateLimitBytes: manager.rateLimitBytes,
          settingsPath: manager.settingsPath,
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
          writeJson(response, 200, { ok: true, native: false, path: null, error: error instanceof Error ? error.message : String(error) })
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
  '多线程下载器：需要把 http/https 文件下载到这台机器时，使用 downloader 工具（action=add 新建，list 查看进度，pause/resume 断点续传，cancel/remove 清理）。下载在 Host 后台进行，不必等待完成；支持自定义请求头（Cookie/Referer/Authorization）、镜像回退、批量 URL、SHA-256 校验、分片重试与全局限速；小于静默阈值（默认 16 MB，可关闭，关闭后显示全部任务）的文件静默下载，不在面板和对话中显示；达到阈值的任务显示进度曲线；小于单线程阈值（默认 4 MB）的文件单连接下载。用户手动下载（面板填 URL/目录/线程）始终显示并多线程；其余下载视为 Agent 任务，受静默/单线程阈值约束，Agent 自主模式下可由 Agent 指定线程策略。完整用法见 skill multithread-downloader。'

/** 注册给所有会话的技能正文（按需加载，不占常驻提示）。 */
const SKILL_CONTENT = `# 多线程下载器（downloader）

## 何时使用

- 用户给出 http/https 地址，要求下载、保存、抓取文件到这台机器时。
- 需要断点续传、限制线程数，或需要实时进度曲线时优先用它。
- 浏览器页面内的点击/登录不属于本技能，使用 ego_* 浏览器工具。

## 工具

\`downloader({ action, url? | urls?, mirrors?, headers?, sha256?, id?, directory?, filename?, threads? })\`

### action=add

- \`url\` 必填，只支持 http/https。
- \`directory\` 可选，Host 本机绝对路径；省略则用插件默认目录（Known Folder / 用户 Downloads）。面板里点“选择…”：Electron 桌面环境使用系统原生目录对话框（标题“选择下载目录”）；其他环境使用插件内目录浏览器（同样标题，支持面包屑与选择当前目录）。
- \`filename\` 可选，只写文件名，不要带路径分隔符。
- \`threads\` 可选，1..16，默认 4；服务器不支持 Range 时自动回退单连接。
- \`headers\` 可选对象：Cookie / Referer / Authorization 等；遇到 401/403 必须提供。
- \`sha256\` 可选：完成后校验，不匹配则任务失败。
- \`urls\` 可选数组：批量创建（最多 20 个），\`mirrors\` 为每个任务提供备用镜像。
- 分片失败会自动重试（指数退避，最多 4 次），并对 5xx/429/超时生效。
- 小于单线程阈值（默认 4 MB，可关闭）的文件只建一个分片、单连接下载。
- \`singleThread\` 可选：true 强制单连接，false 强制分片；省略时普通模式按阈值，Agent 自主模式下默认分片。
- 返回任务对象，\`id\` 用于后续控制；下载继续在 Host 后台进行，不要等待它完成。

### action=list

返回全部任务：状态、进度、速度、保存路径、错误信息。达到曲线阈值（默认 16 MB）的任务还包含 \`history\`（每秒一个 \`{t,p,s}\` 采样点）。

### action=pause / resume / cancel / remove

用 \`id\` 指定任务：

- \`pause\`：暂停，保留已下载分片，之后可续传。
- \`resume\`：从各分片断点继续；\`failed\` 状态也可重试。
- \`cancel\`：取消并删除 \`.mtd-part\` 临时文件。
- \`remove\`：移除任务记录（必要时先取消）。

### action=clean

清空已完成/失败/已取消的任务记录。

## 面板设置（Web GUI 侧边栏「多线程下载器」）

- **全局限速**：KB/s，0 表示不限；所有任务共享。
- **同时下载任务数**：1..8，超出部分排队。

- **静默下载阈值**：带独立开关，默认开启、16 MB，单位 KB / MB / GB，范围 1 KB–10 GB。仅约束 Agent 发起的下载：小于该值时静默（不进面板/对话条/计数）；用户手动下载始终显示。关闭开关后所有任务都显示。
- **单线程阈值**：带独立开关，默认开启、阈值 4 MB，单位 KB/MB。仅约束 Agent 发起的下载；用户手动下载始终按所选线程数分片。关闭后 Agent 任务也不做单连接降级。
- **Agent 自主模式**：默认开启。开启后面板上的静默/单线程设置被屏蔽（数值保留，仍约束 Agent 任务）；Agent 可用 \`threads\` / \`singleThread\` 指定自己的策略。用户手动下载不受影响。
- 以上都是 Host 级设置，自动保存到 profile 目录下的 \`multithread-downloader.json\`，DSH 重启后恢复；\`cordis.patch.yml\` 只作为首次默认值。

## 界面

- 侧边栏「多线程下载器」图标显示未完成任务数（行尾或图标角标）。
- 对话输入框上方有实时进度条：多任务按总大小切成多段，显示已下载/总大小、聚合百分比、总速度；右侧方形箭头可收起，收起后点居中的胶囊恢复。
- 任务卡片显示进度、速度、线程数、暂停/继续/取消/移除；达到阈值的任务显示进度曲线与 ETA。

## 判断完成

- 轮询 \`list\`，\`status=completed\` 且 \`receivedBytes == totalBytes\` 即完成；\`path\` 是最终保存路径。
- \`status=failed\` 时看 \`error\`：常见为 HTTP 状态码、服务器忽略 Range、文件大小不符。
- 进度可用 \`progress\`（0..1）；达到阈值的任务可用 \`history\` 判断速度是否稳定。

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
    maxConcurrent: numberConfig(config?.maxConcurrent, 3, 1, 8),
    largeFileMb: numberConfig(config?.largeFileMb, DEFAULT_LARGE_FILE_MB, 1, 10240),
    minThreadMb: numberConfig(config?.minThreadMb, DEFAULT_MIN_THREAD_MB, 0, 10240),
    minThreadEnabled: config?.minThreadEnabled !== false,
    agentAutonomy: config?.agentAutonomy !== false,
    silentEnabled: config?.silentEnabled !== false,
    rateLimitBytes: numberConfig(config?.rateLimitKb, 0, 0, 1024 * 1024) * 1024,
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
export const __test = { sanitizeHeaders, retryDelay, RateLimiter, probe, fetchWithRedirects, fileSha256, freeDiskBytes, defaultDownloadDirectory }
