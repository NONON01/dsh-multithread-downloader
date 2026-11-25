/**
 * 文件校验（从下载器拆出的可复用模块）：md5 / sha1 / sha256 / sha512 / crc32。
 */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

/** 支持的文件校验算法；hex 为规范化后的十六进制长度。 */
const CHECKSUM_ALGORITHMS = Object.freeze({
  md5: { label: 'MD5', hex: 32, node: 'md5' },
  sha1: { label: 'SHA-1', hex: 40, node: 'sha1' },
  sha256: { label: 'SHA-256', hex: 64, node: 'sha256' },
  sha512: { label: 'SHA-512', hex: 128, node: 'sha512' },
  crc32: { label: 'CRC32', hex: 8, node: null },
})

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** 流式计算文件校验值；支持 md5/sha1/sha256/sha512/crc32。 */
async function fileChecksum(path, algorithm = 'sha256') {
  const spec = CHECKSUM_ALGORITHMS[algorithm]
  if (spec === undefined) throw new Error(`不支持的校验算法：${algorithm}`)
  const handle = await open(path, 'r')
  const hash = spec.node === null ? null : createHash(spec.node)
  let crc = 0xffffffff
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      const block = buffer.subarray(0, bytesRead)
      if (hash !== null) hash.update(block)
      else {
        for (const byte of block) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
      }
    }
  } finally {
    await handle.close()
  }
  if (hash !== null) return hash.digest('hex')
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

/** 兼容旧调用：默认 SHA-256。 */
async function fileSha256(path) {
  return fileChecksum(path, 'sha256')
}

/** 把请求里的 checksum 或旧 sha256 参数规范化为 { algorithm, value }。 */
function normalizeChecksum(request) {
  const raw = request?.checksum
  let algorithm = ''
  let value = ''
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('checksum 需为 { algorithm, value } 对象')
    algorithm = typeof raw.algorithm === 'string' ? raw.algorithm.trim().toLowerCase() : ''
    value = typeof raw.value === 'string' ? raw.value.trim().toLowerCase() : ''
  } else if (typeof request?.sha256 === 'string' && request.sha256.trim() !== '') {
    algorithm = 'sha256'
    value = request.sha256.trim().toLowerCase()
  }
  if (algorithm === '' && value === '') return null
  const spec = CHECKSUM_ALGORITHMS[algorithm]
  if (spec === undefined) throw new Error(`不支持的校验算法：${algorithm || '(空)'}（可选 md5/sha1/sha256/sha512/crc32）`)
  if (!new RegExp(`^[a-f0-9]{${spec.hex}}$`).test(value)) {
    throw new Error(`${spec.label} 需为 ${spec.hex} 位十六进制`)
  }
  return { algorithm, value }
}

export { CHECKSUM_ALGORITHMS, CRC32_TABLE, fileChecksum, fileSha256, normalizeChecksum }
