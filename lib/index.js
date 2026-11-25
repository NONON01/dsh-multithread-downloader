/**
 * 可复用模块入口。
 *
 * 下载器的内部能力按用途拆成 5 个无状态模块，其它插件或脚本可以直接
 * `import { ... } from 'dsh-multithread-downloader/lib'`（或按子路径导入），
 * 不需要启动下载器、也不需要 DSH 上下文：
 *
 * - `doh`      DNS over HTTPS 解析（A/AAAA/CNAME/TXT…、undici dispatcher）
 * - `net`      URL 校验、请求头规范化、跟随重定向、HEAD/Range 探测、指纹比较
 * - `files`    下载目录解析、原生目录选择、文件名规范化、同名避让、磁盘空间
 * - `limits`   连接配额、令牌桶限速、设备负载自适应、站点风控自适应
 * - `checksum` 文件校验（md5/sha1/sha256/sha512/crc32）
 *
 * 示例：
 * ```js
 * import { doh } from 'dsh-multithread-downloader/lib'
 * const { addresses } = await doh.createDohResolver({ provider: 'alidns' }).resolve('example.com')
 * ```
 */
export * as checksum from './checksum.js'
export * as doh from './doh.js'
export * as files from './files.js'
export * as limits from './limits.js'
export * as net from './net.js'

export { CHECKSUM_ALGORITHMS, fileChecksum, normalizeChecksum } from './checksum.js'
export { DOH_PROVIDERS, createDohDispatcher, createDohResolver, normalizeDohProvider, resolveAddresses, resolverFor } from './doh.js'
export { browseDirectory, defaultDownloadDirectory, filenameFromDisposition, filenameFromUrl, freeDiskBytes, sanitizeFilename, uniqueName, decodeHeaderText, decodeProcessOutput } from './files.js'
export { NATIVE_PICKER, SETTINGS_SCHEMA_VERSION } from './files.js'
export { ConnectionSlots, LoadGovernor, RateLimiter, SiteGovernor, SiteLimiter, loadStepFor, siteKeyForUrl } from './limits.js'
export { fetchWithRedirects, fingerprintChange, ifRangeValue, probe, sanitizeHeaders } from './net.js'

// package.json 的 main 指向本文件：既导出可复用模块，也导出插件本体，
// 让 Node 侧 `import 'dsh-multithread-downloader'` 和插件加载都能用同一个入口。
export { apply, inject } from '../index.js'
