/**
 * 目录、文件名与磁盘工具（从下载器拆出的可复用模块）。
 *
 * 不依赖下载器状态：Known Folder 解析、原生目录选择、文件名规范化、同名避让、
 * 线程数阶梯与磁盘剩余空间。
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { open, readdir, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 随插件分发的 Windows 原生目录选择器。 */
const NATIVE_PICKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'picker.exe')

/** 展开 Windows 注册表里的 %VAR%，保持原样表示无法展开。 */
function expandWindowsEnvironment(value) {
  return value.replace(/%([^%]+)%/g, (match, name) => {
    const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    return key === undefined ? match : process.env[key]
  })
}

/**
 * 解码外部进程的输出。
 *
 * Windows 的 `reg.exe`、`chcp` 等控制台程序按当前 OEM 代码页（中文系统是 GBK）
 * 写管道，而不是 UTF-8；直接按 UTF-8 解码会把中文路径变成乱码。
 * 先严格按 UTF-8 解，失败再回退 OEM 代码页（Node 的 gbk 标签实际是 GB18030）。
 */
function decodeProcessOutput(buffer, fallbackEncoding = 'gbk') {
  if (buffer === undefined || buffer === null || buffer.length === 0) return ''
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder(fallbackEncoding).decode(bytes)
    } catch {
      return bytes.toString('latin1')
    }
  }
}

/** 把子进程的 stdout/stderr 收成 Buffer，避免多字节字符被分块截断。 */
function collectProcessOutput(child) {
  const output = { stdout: [], stderr: [] }
  child.stdout.on('data', (chunk) => { output.stdout.push(chunk) })
  child.stderr.on('data', (chunk) => { output.stderr.push(chunk) })
  return {
    readStdout: () => decodeProcessOutput(Buffer.concat(output.stdout)).trim(),
    readStderr: () => decodeProcessOutput(Buffer.concat(output.stderr)).trim(),
  }
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
      { encoding: 'buffer', windowsHide: true, timeout: 1500 },
    )
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return ''
    // reg 的输出按 OEM 代码页编码，中文系统的“下载”目录常带中文用户名。
    const stdout = decodeProcessOutput(result.stdout)
    const match = /REG_\w+\s+(.+?)\r?$/m.exec(stdout)
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
    const output = collectProcessOutput(child)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        const picked = output.readStdout()
        resolve(picked === '' ? null : picked)
        return
      }
      if (code === 2) {
        resolve(null)
        return
      }
      const stderr = output.readStderr()
      reject(new Error(stderr !== '' ? stderr : `native picker exited ${code}`))
    })
  })
}

/** 运行一个外部选择器进程；取消返回 null，启动失败抛错。 */
function runPickerProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    const output = collectProcessOutput(child)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        const picked = output.readStdout()
        resolve(picked === '' ? null : picked)
        return
      }
      if (code === 1) {
        resolve(null)
        return
      }
      const stderr = output.readStderr()
      reject(new Error(stderr !== '' ? stderr : `${command} exited ${code}`))
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

/** settings 文件当前 schema 版本；旧版本遗留的字段在读取时被丢弃。 */
const SETTINGS_SCHEMA_VERSION = 13

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
    if (typeof data.autoThreads === 'boolean') settings.autoThreads = data.autoThreads
    if (typeof data.fingerprintResume === 'boolean') settings.fingerprintResume = data.fingerprintResume
    if (Number.isFinite(data.rateLimitBytes)) settings.rateLimitBytes = data.rateLimitBytes
    // v10 及更早把"任务限制数"写进 maxConcurrent，和现在的并发上限不是同一个量，
    // 这里只认 maxConnections；旧键忽略后并发上限回到插件默认值，而不是继承旧的任务数。
    if (Number.isFinite(data.maxConnections)) settings.maxConnections = data.maxConnections
    if (typeof data.loadAdaptive === 'boolean') settings.loadAdaptive = data.loadAdaptive
    if (typeof data.siteAdaptive === 'boolean') settings.siteAdaptive = data.siteAdaptive
    if (typeof data.dohEnabled === 'boolean') settings.dohEnabled = data.dohEnabled
    if (typeof data.dohProvider === 'string') settings.dohProvider = data.dohProvider
    if (typeof data.githubEnabled === 'boolean') settings.githubEnabled = data.githubEnabled
    if (typeof data.stallWatchdog === 'boolean') settings.stallWatchdog = data.stallWatchdog
    if (Number.isFinite(data.stallWindowSec)) settings.stallWindowSec = data.stallWindowSec
    // 非枚举字段：只给调用方判断是否需要重写文件，不参与 applySettings。
    Object.defineProperty(settings, 'schemaVersion', { value: Number(data.version), enumerable: false })
    return settings
  } catch {
    return {}
  }
}

/**
 * 解码 Content-Disposition 里的文件名。
 *
 * HTTP 头在 undici 里是按 latin1 拿到的字节串：站点若直接写 UTF-8 能解开，
 * 老站点按 GBK（中文 Windows 常见）写就会变成乱码，这里先试 UTF-8 再回退 GBK。
 */
function decodeHeaderText(value) {
  const text = String(value ?? '')
  if (text === '' || /^[\u0020-\u007e]*$/.test(text)) return text
  const bytes = Buffer.from(text, 'latin1')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      return text
    }
  }
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
  return plain === null ? '' : decodeHeaderText(plain[1].trim())
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

/** 从 URL 推断文件名；非法百分号编码回退到未解码路径，避免整个任务失败。 */
function filenameFromUrl(url) {
  const tail = url.pathname.split('/').pop() ?? ''
  let raw = tail
  try {
    raw = decodeURIComponent(tail)
  } catch {
    // 形如 %zz 的非法编码：按原样取文件名，交给 sanitizeFilename 清理。
  }
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

/**
 * 分片数阶梯：仅在调用方没有显式指定线程数、且开启 autoThreads 时生效。
 * 小文件本来就受单线程阈值约束，这里只负责中大型文件别一直用 4 条连接。
 */
function autoThreadsForBytes(size) {
  if (!Number.isFinite(size) || size <= 0) return 1
  if (size < 32 * 1024 * 1024) return 4
  if (size < 256 * 1024 * 1024) return 6
  return 8
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

export {
  NATIVE_PICKER,
  expandWindowsEnvironment,
  decodeProcessOutput,
  collectProcessOutput,
  windowsDownloadDirectory,
  xdgDownloadDirectory,
  electronDialog,
  pickWindowsHelper,
  runPickerProcess,
  pickMacDirectory,
  pickLinuxDirectory,
  pickNativeDirectory,
  browseDirectory,
  defaultDownloadDirectory,
  readSettingsFile,
  SETTINGS_SCHEMA_VERSION,
  filenameFromDisposition,
  decodeHeaderText,
  sanitizeFilename,
  filenameFromUrl,
  uniqueName,
  autoThreadsForBytes,
  freeDiskBytes,
}
