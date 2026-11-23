import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../index.js'

const {
  sanitizeHeaders, retryDelay, RateLimiter, probe, fetchWithRedirects, fileSha256, fileChecksum,
  normalizeChecksum, parseGithubReleaseUrl, normalizeDohProvider, autoThreadsForBytes,
  fingerprintChange, ifRangeValue, DownloadTask,
} = __test

const MB = 1024 * 1024

function stubManager(directory, overrides = {}) {
  return {
    root: directory,
    defaultThreads: 4,
    autoThreads: true,
    fingerprintResume: true,
    minThreadEnabled: true,
    minThreadBytes: 4 * MB,
    silentEnabled: true,
    largeFileBytes: 16 * MB,
    limiter: new RateLimiter(0),
    shouldDisplay: () => true,
    persistTasks: () => {},
    pump: () => {},
    reserveName: async (_dir, name) => name,
    releaseName: () => {},
    dohAgent: () => undefined,
    ...overrides,
  }
}

function makeTask(manager, url, overrides = {}) {
  return new DownloadTask(manager, {
    id: 'test-task',
    urls: [url],
    dir: manager.root,
    filename: '',
    threads: manager.defaultThreads,
    origin: 'agent',
    doh: false,
    ...overrides,
  })
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('sanitizeHeaders strips transport-controlled headers', () => {
  const headers = sanitizeHeaders({
    Cookie: 'a=b',
    Range: 'bytes=0-1',
    'Accept-Encoding': 'gzip',
    'X-Token': ' secret ',
  })
  assert.deepEqual(headers, { cookie: 'a=b', 'x-token': 'secret' })
})

test('sanitizeHeaders rejects invalid names', () => {
  assert.throws(() => sanitizeHeaders({ 'bad header': 'x' }), /非法 header 名/)
  assert.throws(() => sanitizeHeaders([]), /键值对象/)
})

test('retryDelay honours Retry-After and caps exponential backoff', () => {
  const response = { headers: { get: (name) => (name === 'retry-after' ? '2' : null) } }
  assert.equal(retryDelay(1, response), 2000)
  assert.ok(retryDelay(1) >= 500 && retryDelay(1) <= 750)
  assert.ok(retryDelay(10) >= 8000 && retryDelay(10) <= 8250)
})

test('RateLimiter throttles to the configured rate', async () => {
  const limiter = new RateLimiter(20_000)
  const started = Date.now()
  await limiter.take(20_000)
  await limiter.take(20_000)
  assert.ok(Date.now() - started >= 700, 'two 20KB takes at 20KB/s should wait')
})

test('probe reads size and range support', async () => {
  const body = Buffer.alloc(4096, 7)
  const { server, port } = await listen((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
      return
    }
    if (range === null) {
      res.writeHead(200, { 'content-length': String(body.length) }).end(body)
      return
    }
    const start = Number(range[1])
    const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1)
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${body.length}`,
    }).end(body.subarray(start, end + 1))
  })
  try {
    const result = await probe(`http://127.0.0.1:${port}/file`, new AbortController().signal)
    assert.equal(result.size, body.length)
    assert.equal(result.ranges, true)
  } finally {
    await close(server)
  }
})

test('probe explains 401 with a headers hint', async () => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(401).end('no')
  })
  try {
    await assert.rejects(
      probe(`http://127.0.0.1:${port}/auth`, new AbortController().signal),
      /HTTP 401：需要登录或防盗链/,
    )
  } finally {
    await close(server)
  }
})

test('cross-origin redirect drops cookie and authorization', async () => {
  let received = null
  const target = await listen((req, res) => {
    received = req.headers
    res.writeHead(206, { 'content-range': 'bytes 0-0/1', 'content-length': '1' }).end(Buffer.from([1]))
  })
  const origin = await listen((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.port}/target` }).end()
  })
  try {
    const fetched = await fetchWithRedirects(
      `http://127.0.0.1:${origin.port}/start`,
      { headers: { cookie: 'secret', authorization: 'Bearer x', 'x-keep': '1' } },
      new AbortController().signal,
    )
    await fetched.response.body?.cancel().catch(() => {})
    fetched.release()
    assert.equal(received.cookie, undefined)
    assert.equal(received.authorization, undefined)
    assert.equal(received['x-keep'], '1')
  } finally {
    await close(origin.server)
    await close(target.server)
  }
})

test('fileSha256 matches crypto', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-test-'))
  const file = join(directory, 'sample.bin')
  const data = Buffer.from('dsh-multithread-downloader')
  try {
    await writeFile(file, data)
    const expected = createHash('sha256').update(data).digest('hex')
    assert.equal(await fileSha256(file), expected)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('fileChecksum supports md5, sha512 and crc32', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-test-'))
  const file = join(directory, 'sample.bin')
  const data = Buffer.from('123456789')
  try {
    await writeFile(file, data)
    assert.equal(await fileChecksum(file, 'md5'), createHash('md5').update(data).digest('hex'))
    assert.equal(await fileChecksum(file, 'sha1'), createHash('sha1').update(data).digest('hex'))
    assert.equal(await fileChecksum(file, 'sha512'), createHash('sha512').update(data).digest('hex'))
    assert.equal(await fileChecksum(file, 'crc32'), 'cbf43926')
    await assert.rejects(fileChecksum(file, 'sha3'), /不支持的校验算法/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('normalizeChecksum validates algorithms and legacy sha256', () => {
  const value = 'a'.repeat(64)
  assert.deepEqual(normalizeChecksum({ checksum: { algorithm: 'SHA256', value } }), { algorithm: 'sha256', value })
  assert.deepEqual(normalizeChecksum({ sha256: value }), { algorithm: 'sha256', value })
  assert.equal(normalizeChecksum({}), null)
  assert.throws(() => normalizeChecksum({ checksum: { algorithm: 'md5', value } }), /MD5 需为 32 位十六进制/)
  assert.throws(() => normalizeChecksum({ checksum: { algorithm: 'sha3', value } }), /不支持的校验算法/)
})


test('parseGithubReleaseUrl accepts release download links', () => {
  const parsed = parseGithubReleaseUrl('https://github.com/ip7z/7zip/releases/download/26.06/7z2606-x64.exe')
  assert.deepEqual(parsed, { owner: 'ip7z', repo: '7zip', tag: '26.06', asset: '7z2606-x64.exe' })
  assert.equal(parseGithubReleaseUrl('https://github.com/ip7z/7zip'), null)
})

test('normalizeDohProvider falls back to alidns', () => {
  assert.equal(normalizeDohProvider('cloudflare'), 'cloudflare')
  assert.equal(normalizeDohProvider('tencent'), 'tencent')
  assert.equal(normalizeDohProvider('unknown'), 'alidns')
})

test('autoThreadsForBytes follows the size ladder', () => {
  assert.equal(autoThreadsForBytes(0), 1)
  assert.equal(autoThreadsForBytes(1024), 4)
  assert.equal(autoThreadsForBytes(31 * MB), 4)
  assert.equal(autoThreadsForBytes(32 * MB), 6)
  assert.equal(autoThreadsForBytes(255 * MB), 6)
  assert.equal(autoThreadsForBytes(256 * MB), 8)
})

test('ifRangeValue prefers strong ETag and falls back to Last-Modified', () => {
  assert.equal(ifRangeValue('"abc"', 'Mon, 01 Jan 2024 00:00:00 GMT'), '"abc"')
  assert.equal(ifRangeValue('W/"abc"', 'Mon, 01 Jan 2024 00:00:00 GMT'), 'Mon, 01 Jan 2024 00:00:00 GMT')
  assert.equal(ifRangeValue('', 'Mon, 01 Jan 2024 00:00:00 GMT'), 'Mon, 01 Jan 2024 00:00:00 GMT')
  assert.equal(ifRangeValue('', ''), '')
})

test('fingerprintChange reports size, etag and last-modified changes', () => {
  assert.equal(fingerprintChange({ size: 1, etag: '"a"' }, { size: 2, etag: '"a"' }), 'size')
  assert.equal(fingerprintChange({ size: 1, etag: '"a"' }, { size: 1, etag: '"b"' }), 'etag')
  assert.equal(fingerprintChange({ size: 1, lastModified: 'd1' }, { size: 1, lastModified: 'd2' }), 'last-modified')
  assert.equal(fingerprintChange({ size: 1, etag: '"a"' }, { size: 1, etag: '"a"' }), '')
})

test('buildChunks uses the ladder unless threads are explicit', () => {
  const manager = stubManager('/tmp')
  const task = makeTask(manager, 'http://127.0.0.1:1/x')
  task.totalBytes = 40 * MB
  assert.equal(task.buildChunks({ size: 40 * MB, ranges: true }).length, 6)
  task.totalBytes = 300 * MB
  assert.equal(task.buildChunks({ size: 300 * MB, ranges: true }).length, 8)
  task.threadsExplicit = true
  task.threads = 2
  assert.equal(task.buildChunks({ size: 300 * MB, ranges: true }).length, 2)
  manager.autoThreads = false
  task.threadsExplicit = false
  task.threads = 3
  assert.equal(task.buildChunks({ size: 300 * MB, ranges: true }).length, 3)
})

test('download completes and verifies a stable fingerprint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-fp-'))
  const body = Buffer.alloc(1536 * 1024, 1)
  const etag = '"stable-v1"'
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes', etag }).end()
      return
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = Number(range[1])
    const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1)
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${body.length}`,
      etag,
    }).end(body.subarray(start, end + 1))
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { singleThread: false, threads: 4, threadsExplicit: true })
    task.status = 'probing'
    await task.run()
    assert.equal(task.status, 'completed')
    assert.equal(task.fingerprintState, 'verified')
    assert.deepEqual(await readFile(task.path), body)
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a mid-download etag change restarts and delivers the new version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-fp-'))
  const first = Buffer.alloc(1536 * 1024, 1)
  const second = Buffer.alloc(1536 * 1024, 2)
  const etags = { 1: '"v1"', 2: '"v2"' }
  const bodies = { 1: first, 2: second }
  let version = 1
  let switched = false
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      const body = bodies[version]
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes', etag: etags[version] }).end()
      return
    }
    if (!switched) {
      switched = true
      version = 2
    }
    const body = bodies[version]
    const currentEtag = etags[version]
    const ifRange = req.headers['if-range']
    if (ifRange !== undefined && ifRange !== currentEtag) {
      res.writeHead(200, { 'content-length': String(body.length), etag: currentEtag }).end(body)
      return
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = Number(range[1])
    const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1)
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${body.length}`,
      etag: currentEtag,
    }).end(body.subarray(start, end + 1))
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { singleThread: false, threads: 4, threadsExplicit: true })
    task.status = 'probing'
    await task.run()
    assert.equal(task.status, 'completed')
    assert.match(task.fingerprintNote, /已变化/)
    assert.deepEqual(await readFile(task.path), second)
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('resume revalidates and redownloads when the remote version changed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-fp-'))
  const oldBody = Buffer.alloc(1536 * 1024, 1)
  const newBody = Buffer.alloc(1536 * 1024, 3)
  const { server, port } = await listen((req, res) => {
    const etag = '"v2"'
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(newBody.length), 'accept-ranges': 'bytes', etag }).end()
      return
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = Number(range[1])
    const end = range[2] === '' ? newBody.length - 1 : Math.min(Number(range[2]), newBody.length - 1)
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${newBody.length}`,
      etag,
    }).end(newBody.subarray(start, end + 1))
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { singleThread: false, threads: 4, threadsExplicit: true })
    const path = join(directory, 'file.bin')
    await writeFile(`${path}.mtd-part`, oldBody.subarray(0, 512 * 1024))
    task.filename = 'file.bin'
    task.path = path
    task.partPath = `${path}.mtd-part`
    task.totalBytes = oldBody.length
    task.etag = '"v1"'
    task.chunks = [{ start: 0, end: oldBody.length - 1, cursor: 512 * 1024, total: oldBody.length }]
    task.receivedBytes = 512 * 1024
    await task.writeMeta()
    await task.runChunks()
    assert.equal(task.status, 'completed')
    assert.equal(task.fingerprintState, 'verified')
    assert.deepEqual(await readFile(path), newBody)
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('resume refuses to continue when the remote cannot be verified', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-fp-'))
  const { server, port } = await listen((_req, res) => {
    res.writeHead(500).end('boom')
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { singleThread: false, threads: 4 })
    const path = join(directory, 'file.bin')
    await writeFile(`${path}.mtd-part`, Buffer.alloc(512 * 1024, 1))
    task.filename = 'file.bin'
    task.path = path
    task.partPath = `${path}.mtd-part`
    task.totalBytes = 1536 * 1024
    task.etag = '"v1"'
    task.chunks = [{ start: 0, end: task.totalBytes - 1, cursor: 512 * 1024, total: task.totalBytes }]
    task.receivedBytes = 512 * 1024
    await task.writeMeta()
    await assert.rejects(task.runChunks(), /无法校验续传指纹/)
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})
