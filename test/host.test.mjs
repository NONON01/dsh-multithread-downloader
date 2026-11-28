import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../index.js'
import * as lib from '../lib/index.js'

const {
  sanitizeHeaders, retryDelay, RateLimiter, ConnectionSlots, probe, fetchWithRedirects, fileSha256, fileChecksum,
  normalizeChecksum, parseGithubReleaseUrl, normalizeDohProvider, autoThreadsForBytes,
  fingerprintChange, ifRangeValue, DownloadTask, Downloader, LoadGovernor, SiteGovernor, SiteLimiter,
  siteKeyForUrl, cpuPercentBetween, loadStepFor, memoryPressurePercent, signedUrlExpiry, headersForRedirect,
  httpStatusOf, SITE_LEVELS, makeDohTool, makeProbeTool,
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
    maxConnections: 16,
    slots: new ConnectionSlots(16),
    siteAdaptive: true,
    siteGovernor: new SiteGovernor(true),
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

test('a single task never exceeds the global connection budget', () => {
  const manager = stubManager('/tmp', { maxConnections: 2 })
  const task = makeTask(manager, 'http://127.0.0.1:1/x', { threads: 8, threadsExplicit: true })
  task.totalBytes = 300 * MB
  assert.equal(task.buildChunks({ size: 300 * MB, ranges: true }).length, 2)
})

test('ConnectionSlots hands out exactly the configured number of slots', async () => {
  const slots = new ConnectionSlots(2)
  const first = await slots.acquire()
  const second = await slots.acquire()
  assert.equal(slots.used, 2)
  let third = null
  const pending = slots.acquire().then((release) => { third = release })
  await Promise.resolve()
  assert.equal(third, null)
  first()
  await pending
  assert.equal(typeof third, 'function')
  assert.equal(slots.used, 2)
  second()
  third()
  assert.equal(slots.used, 0)
})

test('ConnectionSlots drops a queued waiter when its signal aborts', async () => {
  const slots = new ConnectionSlots(1)
  const first = await slots.acquire()
  const controller = new AbortController()
  const queued = slots.acquire(controller.signal)
  controller.abort()
  assert.equal(await queued, null)
  assert.equal(slots.waiters.length, 0)
  first()
  assert.equal(slots.used, 0)
})

test('ConnectionSlots raising the limit wakes queued waiters', async () => {
  const slots = new ConnectionSlots(1)
  const first = await slots.acquire()
  const queued = slots.acquire()
  slots.setLimit(2)
  const release = await queued
  assert.equal(slots.used, 2)
  release()
  first()
  assert.equal(slots.used, 0)
})

test('two tasks share one connection slot and never overlap requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-budget-'))
  const body = Buffer.alloc(1024 * 1024, 7)
  let active = 0
  let peak = 0
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
      return
    }
    active += 1
    peak = Math.max(peak, active)
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = range === null ? 0 : Number(range[1])
    const end = range === null || range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1)
    setTimeout(() => {
      res.writeHead(206, {
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${body.length}`,
      }).end(body.subarray(start, end + 1))
      active -= 1
    }, 30)
  })
  try {
    const manager = stubManager(directory, { maxConnections: 1, slots: new ConnectionSlots(1) })
    const first = makeTask(manager, `http://127.0.0.1:${port}/a.bin`)
    const second = makeTask(manager, `http://127.0.0.1:${port}/b.bin`)
    first.status = 'probing'
    second.status = 'probing'
    await Promise.all([first.run(), second.run()])
    assert.equal(first.status, 'completed')
    assert.equal(second.status, 'completed')
    assert.equal(peak, 1)
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a file larger than one connection piece downloads across pieces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-piece-'))
  const body = Buffer.alloc(9 * MB, 5)
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
      return
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = range === null ? 0 : Number(range[1])
    const end = range === null || range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1)
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${body.length}`,
    }).end(body.subarray(start, end + 1))
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/big.bin`, { singleThread: true })
    task.status = 'probing'
    await task.run()
    assert.equal(task.status, 'completed')
    assert.equal(task.receivedBytes, body.length)
    assert.deepEqual(await readFile(task.path), body)
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
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

test('a server without Range support downloads once through a single connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-single-'))
  const body = Buffer.alloc(1536 * 1024, 4)
  let hits = 0
  const { server, port } = await listen((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { singleThread: false, threads: 4, threadsExplicit: true })
    task.status = 'probing'
    await task.run()
    assert.equal(task.status, 'completed', task.error)
    assert.deepEqual(await readFile(task.path), body)
    // 探测 HEAD + 探测 Range + 一次正文：不多不少，绝不能整段重下。
    assert.ok(hits >= 2 && hits <= 4, `unexpected request count: ${hits}`)
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a server that ignores Range falls back to one connection instead of failing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-norange-'))
  const body = Buffer.alloc(1536 * 1024, 5)
  const etag = '"no-range"'
  const rangesSeen = []
  const { server, port } = await listen((req, res) => {
    rangesSeen.push(req.headers.range ?? '')
    // 声称支持 Range，实际永远回整个文件；ETag 与探测一致 → 不是换了版本，而是忽略 Range。
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes', etag })
    res.end(body)
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { singleThread: false, threads: 4, threadsExplicit: true })
    task.status = 'probing'
    await task.run()
    assert.equal(task.status, 'completed', task.error)
    assert.equal(task.rangeFallback, true)
    assert.deepEqual(await readFile(task.path), body)
    // 回退后最后那次请求不带 Range，整段一次读完。
    assert.equal(rangesSeen[rangesSeen.length - 1], '')
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a redirected download reuses the final URL instead of re-following it per chunk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-302-'))
  const body = Buffer.alloc(1536 * 1024, 7)
  const etag = '"redirect-v1"'
  let hops = 0
  const asset = await listen((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (req.method === 'HEAD' || range === null) {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes', etag }).end()
      return
    }
    const start = Number(range[1])
    const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1)
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${body.length}`,
      etag,
    }).end(body.subarray(start, end + 1))
  })
  const edge = await listen((_req, res) => {
    hops += 1
    res.writeHead(302, { location: `http://127.0.0.1:${asset.port}/asset.bin` }).end()
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${edge.port}/download`, { singleThread: false, threads: 4, threadsExplicit: true })
    task.status = 'probing'
    await task.run()
    assert.equal(task.status, 'completed', task.error)
    assert.deepEqual(await readFile(task.path), body)
    // 跳转只在探测时走一次；后续分片和收尾复核都直接打最终地址。
    assert.equal(hops, 1)
  } finally {
    await close(asset.server)
    await close(edge.server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('redirect helpers strip credentials cross-origin and read signed expiry', () => {
  const headers = { cookie: 'a=b', authorization: 'Bearer t', 'x-token': 'k' }
  assert.deepEqual(headersForRedirect(headers, 'https://a.test/x', 'https://b.test/y'), { 'x-token': 'k' })
  assert.deepEqual(headersForRedirect(headers, 'https://a.test/x', 'https://a.test/y'), headers)
  assert.equal(signedUrlExpiry('https://cdn.test/f?se=2026-01-02T03:04:05Z'), Date.parse('2026-01-02T03:04:05Z'))
  assert.equal(signedUrlExpiry('https://cdn.test/f'), 0)
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
    await task.runChunks()
    // runChunks 不向外抛错（避免和调用方的 .catch 重复判失败），失败落在任务状态上。
    assert.equal(task.status, 'failed')
    assert.match(task.error, /无法校验续传指纹/)
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('siteKeyForUrl groups one site loosely by registrable domain', () => {
  const pages = ['https://www.example.com/a/1', 'https://example.com/b/2', 'http://cdn.example.com/c', 'https://img.example.com:8443/d']
  assert.deepEqual([...new Set(pages.map(siteKeyForUrl))], ['example.com'])
  assert.equal(siteKeyForUrl('https://shop.example.com.cn/x'), 'example.com.cn')
  assert.equal(siteKeyForUrl('https://img.bbc.co.uk/news'), 'bbc.co.uk')
  assert.equal(siteKeyForUrl('https://api.github.com/repos/a/b'), 'github.com')
  assert.equal(siteKeyForUrl('https://objects.githubusercontent.com/gh/x'), 'github.com')
  assert.equal(siteKeyForUrl('http://192.168.1.20:8080/file'), '192.168.1.20')
  assert.equal(siteKeyForUrl('ftp://example.com/x'), '')
  assert.equal(siteKeyForUrl('not a url'), '')
})

test('loadStepFor maps pressure to a shrink factor', () => {
  assert.equal(loadStepFor(20).level, 'normal')
  assert.equal(loadStepFor(60).level, 'elevated')
  assert.equal(loadStepFor(90).level, 'high')
  assert.equal(loadStepFor(99).level, 'critical')
  assert.ok(loadStepFor(99).factor < loadStepFor(90).factor)
})

test('memoryPressurePercent only brakes when memory is truly scarce', () => {
  assert.equal(memoryPressurePercent(80), 0)
  assert.equal(memoryPressurePercent(null), 0)
  // Windows 把系统缓存算成已用：空闲物理内存还很多时，占用率再高也不算压力。
  assert.equal(memoryPressurePercent(95, 4 * 1024 * 1024 * 1024), 0)
  assert.ok(memoryPressurePercent(99) > memoryPressurePercent(90))
  // 内存真的快没了才按 88→100 放大到 0→100。
  assert.equal(memoryPressurePercent(88), 0)
  assert.equal(memoryPressurePercent(100), 100)
})

test('cpuPercentBetween measures busy time between samples', () => {
  assert.equal(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 150, total: 300 }), 50)
  assert.equal(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 }), null)
})

test('LoadGovernor ignores a single CPU spike but shrinks on sustained load', () => {
  const governor = new LoadGovernor(5, true)
  assert.equal(governor.observe(20, 40, { active: true }), 5)
  // 起连接时握手会让 CPU 尖一下：单次 90% 不收缩，否则预算会被永久压到最低。
  assert.equal(governor.observe(90, 40, { active: true }), 5)
  // 回落即清零，尖峰不累积。
  assert.equal(governor.observe(20, 40, { active: true }), 5)
  assert.equal(governor.observe(92, 40, { active: true }), 5)
  // 连续两次中度以上压力才收缩（5 × 0.35 = 1.75 → 2）。
  assert.equal(governor.observe(92, 40, { active: true }), 2)
  assert.equal(governor.level, 'high')
})

test('LoadGovernor does not collapse to one connection on cached memory', () => {
  const governor = new LoadGovernor(5, true)
  // 8 GB 机器只剩 700 MB 空闲、占用 91%：占的是文件缓存，不应该把 5 压到 1。
  assert.equal(governor.observe(20, 91, { active: true, freeBytes: 700 * 1024 * 1024 }), 5)
  assert.equal(governor.level, 'normal')
  // 真到内存耗尽才收缩。
  assert.equal(governor.observe(20, 100, { active: true, freeBytes: 64 * 1024 * 1024 }), 5)
  assert.equal(governor.observe(20, 100, { active: true, freeBytes: 64 * 1024 * 1024 }), 1)
  assert.equal(governor.level, 'critical')
})

test('LoadGovernor restores the budget when nothing is downloading', () => {
  const governor = new LoadGovernor(5, true)
  assert.equal(governor.observe(99, 60, { active: true }), 5)
  assert.equal(governor.observe(99, 60, { active: true }), 1)
  // 连接全部结束：空闲机器没有要保护的东西，预算回到设定值。
  assert.equal(governor.observe(99, 60, { active: false }), 5)
  assert.equal(governor.level, 'normal')
  assert.equal(governor.observe(20, 40, { active: true }), 5)
})

test('LoadGovernor shrinks on severe load and recovers step by step', () => {
  const governor = new LoadGovernor(16, true)
  assert.equal(governor.observe(20, 30, { active: true }), 16)
  // 真过载也要连续两个采样：一次 2 秒的尖峰不足以证明机器撑不住。
  assert.equal(governor.observe(97, 50, { active: true }), 16)
  assert.equal(governor.observe(97, 50, { active: true }), 3)
  assert.equal(governor.level, 'critical')
  // 回落后需要连续两个采样周期才抬一档（每次 1/4 基础值）
  assert.equal(governor.observe(20, 20, { active: true }), 3)
  assert.equal(governor.observe(20, 20, { active: true }), 7)
  assert.equal(governor.observe(20, 20, { active: true }), 7)
  assert.equal(governor.observe(20, 20, { active: true }), 11)
  for (let index = 0; index < 10; index += 1) governor.observe(20, 20, { active: true })
  assert.equal(governor.limit, 16)
  // 再次过载：同样要连续两次采样才收缩
  assert.equal(governor.observe(88, 30, { active: true }), 16)
  assert.equal(governor.observe(88, 30, { active: true }), 6)
  // 关闭自适应时回到用户设定值
  assert.equal(governor.setEnabled(false), 16)
  // 重新开启时按最近一次采样（仍为高负载）收缩，而不是先放满
  assert.equal(governor.setEnabled(true), 6)
  governor.observe(20, 20, { active: true })
  governor.observe(20, 20, { active: true })
  assert.equal(governor.limit, 10)
})

test('SiteLimiter escalates on risk signals and recovers after enough successes', () => {
  const site = new SiteLimiter('example.com')
  assert.equal(site.level, 0)
  const first = site.penalize(403, 1000)
  assert.equal(site.level, 1)
  assert.equal(first.cap, SITE_LEVELS[1].cap)
  assert.ok(site.notBefore >= 1000 + SITE_LEVELS[1].cooldownMs)
  const second = site.penalize(429, 2000)
  assert.equal(site.level, 2)
  assert.ok(second.rate < first.rate)
  // 连续成功达到阈值才回落一档
  for (let index = 0; index < 47; index += 1) site.reward()
  assert.equal(site.level, 2)
  site.reward()
  assert.equal(site.level, 1)
  for (let index = 0; index < 24; index += 1) site.reward()
  assert.equal(site.level, 0)
})

test('SiteLimiter walks the whole recovery ramp from the deepest level', () => {
  const site = new SiteLimiter('example.com')
  const deepest = SITE_LEVELS.length - 1
  // 连续命中风控升到最深档，但不会越过最后一档。
  for (let hit = 0; hit < 10; hit += 1) site.penalize(429, 1000 + hit)
  assert.equal(site.level, deepest)
  assert.equal(site.cap, SITE_LEVELS[deepest].cap)
  assert.equal(site.rateBytes, SITE_LEVELS[deepest].rate)
  // 每上升一档要连续成功 24 × 当前档位段：4→3 是 96 段，3→2 是 72，2→1 是 48，1→0 是 24。
  const ramps = [96, 72, 48, 24]
  for (const [index, count] of ramps.entries()) {
    const before = deepest - index
    for (let step = 0; step < count - 1; step += 1) site.reward()
    // 差一段不算：必须刚好凑够才回升，否则刚放行又被风控。
    assert.equal(site.level, before)
    site.reward()
    assert.equal(site.level, before - 1)
    // 回升一档就立刻放宽连接上限与聚合限速。
    assert.equal(site.cap, SITE_LEVELS[before - 1].cap)
    assert.equal(site.rateBytes, SITE_LEVELS[before - 1].rate)
  }
  assert.equal(site.level, 0)
  // 回到 0 档后继续成功不会掉成负数（-1 会让 SITE_LEVELS 取到 undefined）。
  site.reward()
  site.reward()
  assert.equal(site.level, 0)
  assert.equal(site.signals, 10)
})

test('SiteGovernor keeps each site policy independent', () => {
  const governor = new SiteGovernor(true)
  governor.penalize('https://a.example.com/1', 403)
  assert.equal(governor.sites.get('example.com').level, 1)
  assert.equal(governor.sites.has('other.org'), false)
  const other = governor.limiterFor('https://other.org/file')
  assert.equal(other.level, 0)
  // 同一站点不同页面共用同一档位
  governor.penalize('https://example.com/page-2', 403)
  assert.equal(governor.sites.get('example.com').level, 2)
  assert.equal(governor.snapshot().length, 1)
  // 关闭站点自适应后清空
  governor.setEnabled(false)
  assert.equal(governor.snapshot().length, 0)
})

test('manager lowers the connection budget under device load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-load-'))
  const manager = new Downloader({
    directory,
    threads: 4,
    maxConnections: 16,
    largeFileMb: 16,
    minThreadMb: 4,
    minThreadEnabled: true,
    agentAutonomy: true,
    autoThreads: true,
    fingerprintResume: true,
    silentEnabled: true,
    rateLimitBytes: 0,
    settingsPath: '',
    tasksPath: '',
  })
  try {
    // 设备负载只对「正在跑连接」的下载收预算；空闲时不应留下被压低的预算。
    manager.slots.used = 3
    manager.applyResourceSample({ cpuPct: 96, memoryPct: 40, takenAt: Date.now() })
    // 单次尖峰不收缩，连续两个采样才降档。
    assert.equal(manager.effectiveConnections, 16)
    manager.applyResourceSample({ cpuPct: 96, memoryPct: 40, takenAt: Date.now() })
    assert.equal(manager.effectiveConnections, 3)
    assert.equal(manager.maxConcurrent, 3)
    assert.equal(manager.resourceState().level, 'critical')
    for (let index = 0; index < 14; index += 1) manager.applyResourceSample({ cpuPct: 10, memoryPct: 20, takenAt: Date.now() })
    assert.equal(manager.effectiveConnections, 16)
    // 用户改上限仍受负载约束
    manager.applySettings({ maxConnections: 8 })
    assert.equal(manager.maxConnections, 8)
    assert.equal(manager.effectiveConnections, 8)
    manager.applyResourceSample({ cpuPct: 99, memoryPct: 30, takenAt: Date.now() })
    manager.applyResourceSample({ cpuPct: 99, memoryPct: 30, takenAt: Date.now() })
    assert.equal(manager.effectiveConnections, 2)
    // 连接全部结束：预算回到用户设定值，下一次任务不会从 2 条起步。
    manager.slots.used = 0
    manager.applyResourceSample({ cpuPct: 99, memoryPct: 30, takenAt: Date.now() })
    assert.equal(manager.effectiveConnections, 8)
    manager.applySettings({ loadAdaptive: false })
    assert.equal(manager.effectiveConnections, 8)
  } finally {
    manager.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a 403 risk signal throttles the site and the download resumes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-risk-'))
  const body = Buffer.alloc(1024 * 1024, 9)
  let blocked = 1
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
      return
    }
    if (blocked > 0) {
      blocked -= 1
      res.writeHead(403).end('blocked')
      return
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = range === null ? 0 : Number(range[1])
    const end = range === null || range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1)
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${body.length}`,
    }).end(body.subarray(start, end + 1))
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { singleThread: true })
    task.status = 'probing'
    const started = Date.now()
    await task.run()
    assert.equal(task.status, 'completed')
    assert.deepEqual(await readFile(task.path), body)
    assert.ok(task.riskRetries >= 1, 'risk retry should be recorded')
    assert.match(task.riskNote, /风控/)
    // 冷却确实发生过：403 之后的第一次重试至少等了一个最小冷却
    assert.ok(Date.now() - started >= SITE_LEVELS[1].cooldownMs)
    const sites = manager.siteGovernor.snapshot()
    assert.equal(sites.length, 1)
    assert.equal(sites[0].level, 1)
    assert.equal(sites[0].connections, SITE_LEVELS[1].cap)
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a throttled site does not slow a download from another site', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-risk2-'))
  const body = Buffer.alloc(512 * 1024, 4)
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
      return
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = Number(range[1])
    const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1)
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${body.length}`,
    }).end(body.subarray(start, end + 1))
  })
  try {
    const manager = stubManager(directory)
    const governor = manager.siteGovernor
    // A 站被风控到最严档位并处于长冷却
    const site = governor.limiterFor(`http://127.0.0.1:${port}/a.bin`)
    site.level = SITE_LEVELS.length - 1
    site.notBefore = Date.now() + 60_000
    site.slots.setLimit(1)
    // B 站是另一个键（localhost 与 127.0.0.1 不同），不受影响
    const other = governor.limiterFor('http://localhost:9/b.bin')
    assert.notEqual(other, site)
    const started = Date.now()
    const task = makeTask(manager, `http://localhost:${port}/b.bin`, { singleThread: false, threads: 2, threadsExplicit: true })
    task.status = 'probing'
    await task.run()
    assert.equal(task.status, 'completed')
    assert.ok(Date.now() - started < 5000, 'other site should not wait for the throttled site cooldown')
    assert.equal(site.level, SITE_LEVELS.length - 1)
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('lib facade exposes the reusable modules independently', () => {
  for (const name of ['doh', 'net', 'limits', 'files', 'checksum']) {
    assert.ok(lib[name] !== undefined, `missing lib module: ${name}`)
  }
  assert.equal(typeof lib.doh.createDohResolver, 'function')
  assert.equal(typeof lib.doh.resolveAddresses, 'function')
  assert.equal(typeof lib.net.probe, 'function')
  assert.equal(typeof lib.net.fetchWithRedirects, 'function')
  assert.equal(typeof lib.limits.SiteGovernor, 'function')
  assert.equal(typeof lib.files.defaultDownloadDirectory, 'function')
  assert.equal(typeof lib.checksum.fileChecksum, 'function')
})

test('a legacy maxConcurrent key never becomes the connection limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-settings-'))
  try {
    const settingsPath = join(directory, 'multithread-downloader.json')
    await writeFile(settingsPath, JSON.stringify({
      version: 10,
      largeFileBytes: 16 * MB,
      maxConcurrent: 3,
    }))
    const settings = lib.files.readSettingsFile(settingsPath)
    // 旧键被忽略，并发上限才会回到插件默认值 16，而不是继承旧的任务数 3。
    assert.equal(settings.maxConnections, undefined)
    assert.equal(settings.largeFileBytes, 16 * MB)
    assert.equal(settings.schemaVersion, 10)
    assert.notEqual(settings.schemaVersion, lib.SETTINGS_SCHEMA_VERSION)
    assert.deepEqual(Object.keys(settings).sort(), ['largeFileBytes'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('decodeProcessOutput reads OEM-encoded Windows output', () => {
  // 中文 Windows 上 reg.exe / 控制台程序按 GBK 写管道，按 UTF-8 解码会变成乱码。
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  assert.equal(lib.files.decodeProcessOutput(gbk), '中文')
  assert.equal(lib.files.decodeProcessOutput(Buffer.from('中文', 'utf8')), '中文')
  assert.equal(lib.files.decodeProcessOutput(Buffer.alloc(0)), '')
})

test('snapshot reports remaining bytes and ETA only while downloading', () => {
  const manager = stubManager('/tmp')
  const task = makeTask(manager, 'https://example.test/a.bin')
  task.totalBytes = 10 * MB
  task.receivedBytes = 4 * MB
  task.speed = MB
  task.status = 'downloading'
  const snapshot = task.snapshot()
  assert.equal(snapshot.remainingBytes, 6 * MB)
  assert.equal(snapshot.etaSeconds, 6)
  // ETA 优先用平滑速度：瞬时速度每秒抖一次，会让「约剩」跟着乱跳。
  task.etaSpeed = 2 * MB
  assert.equal(task.snapshot().etaSeconds, 3)
  task.etaSpeed = 0
  // 暂停或速度未知时不给 ETA，避免误导向的 0 / Infinity。
  task.status = 'paused'
  assert.equal(task.snapshot().etaSeconds, undefined)
  task.status = 'downloading'
  task.speed = 0
  assert.equal(task.snapshot().etaSeconds, undefined)
})

test('progress history folds old samples instead of dropping them, keeping the whole run', () => {
  const manager = stubManager('/tmp')
  const task = makeTask(manager, 'https://example.test/a.bin')
  const base = 1_700_000_000_000
  const hours = 4
  task.startedAt = base
  task.totalBytes = hours * 3600 * MB
  task.history = [{ t: 0, p: 0, s: 0 }]
  for (let second = 1; second <= hours * 3600; second += 1) {
    task.receivedBytes = second * MB
    task.progress = task.receivedBytes / task.totalBytes
    task.speed = MB
    task.recordHistory(base + second * 1000)
  }
  const points = task.snapshot({ history: true }).history
  // 点数预算不变，所以面板响应体不会因为长任务变大。
  assert.ok(points.length <= 240)
  // 全程都在：从第 0 秒到现在，时间严格递增，没有停在「最近几分钟」。
  assert.equal(points[0].t, 0)
  assert.equal(points[points.length - 1].t, hours * 3600)
  for (let index = 1; index < points.length; index += 1) {
    assert.ok(points[index].t > points[index - 1].t)
    assert.ok(points[index].p >= points[index - 1].p)
  }
  // 最近的半分钟仍是 1 秒分辨率。
  const tail = points.slice(-30)
  for (let index = 1; index < tail.length; index += 1) assert.equal(tail[index].t - tail[index - 1].t, 1)
  // 折叠是取均值：粗档那部分的速度仍是真实速度（开头那个种子点的 0 会被后面拉平）。
  const coarse = points.filter((point) => point.t < hours * 3600 - 120)
  assert.ok(coarse.length > 0)
  const coarseAverage = coarse.reduce((sum, point) => sum + point.s, 0) / coarse.length
  assert.ok(coarseAverage > 0.9 * MB && coarseAverage <= MB)
})

test('a short run keeps one history point per second', () => {
  const manager = stubManager('/tmp')
  const task = makeTask(manager, 'https://example.test/a.bin')
  const base = 1_700_000_000_000
  task.startedAt = base
  task.totalBytes = 200 * MB
  task.history = [{ t: 0, p: 0, s: 0 }]
  for (let second = 1; second <= 100; second += 1) {
    task.receivedBytes = second * MB
    task.progress = task.receivedBytes / task.totalBytes
    task.speed = MB
    task.recordHistory(base + second * 1000)
  }
  const points = task.snapshot({ history: true }).history
  assert.equal(points.length, 101)
  for (let index = 1; index < points.length; index += 1) {
    assert.equal(points[index].t - points[index - 1].t, 1)
  }
})

test('add writes into a Chinese-named directory with a Chinese filename', async () => {
  const payload = Buffer.alloc(64 * 1024, 0x41)
  const etag = '"cn-1"'
  const { server, port } = await listen((request, response) => {
    const common = {
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes',
      'etag': etag,
    }
    const range = request.headers.range
    if (typeof range === 'string' && range.startsWith('bytes=')) {
      // If-Range 与当前实体一致才给 206，否则按 RFC 返回完整 200。
      const ifRange = request.headers['if-range']
      if (typeof ifRange === 'string' && ifRange !== '' && ifRange !== etag) {
        response.writeHead(200, { ...common, 'content-length': payload.length })
        response.end(payload)
        return
      }
      const [startText, endText] = range.slice(6).split('-')
      const start = Number(startText)
      const end = endText === '' || endText === undefined ? payload.length - 1 : Math.min(payload.length - 1, Number(endText))
      if (!Number.isFinite(start) || start > end) {
        response.writeHead(416, { ...common, 'content-range': `bytes */${payload.length}` })
        response.end()
        return
      }
      response.writeHead(206, {
        ...common,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${payload.length}`,
      })
      response.end(payload.subarray(start, end + 1))
      return
    }
    response.writeHead(200, {
      ...common,
      'content-length': payload.length,
      'content-disposition': "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87%E6%96%87%E4%BB%B6.bin",
    })
    response.end(payload)
  })
  const base = await mkdtemp(join(tmpdir(), 'mtd-cn-'))
  const directory = join(base, '中文目录')
  await mkdir(directory)
  const manager = new Downloader({
    directory,
    threads: 2,
    maxConnections: 4,
    largeFileMb: 16,
    minThreadMb: 4,
    minThreadEnabled: true,
    agentAutonomy: true,
    autoThreads: true,
    fingerprintResume: true,
    silentEnabled: true,
    loadAdaptive: false,
    siteAdaptive: false,
    rateLimitBytes: 0,
    dohEnabled: false,
    dohProvider: 'alidns',
    githubEnabled: false,
    settingsPath: join(base, 'settings.json'),
    tasksPath: join(base, 'tasks.json'),
  })
  try {
    const created = await manager.add({
      url: `http://127.0.0.1:${port}/download`,
      directory,
      threads: 2,
      origin: 'agent',
    })
    const id = created.id
    for (let index = 0; index < 400 && manager.get(id).status !== 'completed'; index += 1) {
      await new Promise((done) => setTimeout(done, 25))
      if (manager.get(id).status === 'failed') break
    }
    const snapshot = manager.get(id).snapshot()
    assert.equal(snapshot.status, 'completed', snapshot.error)
    // 中文目录与中文文件名都要原样保留，不能出现乱码或被替换成 _。
    assert.equal(snapshot.dir, directory)
    assert.equal(snapshot.filename, '中文文件.bin')
    assert.equal((await readFile(snapshot.path)).length, payload.length)
  } finally {
    manager.dispose()
    await close(server)
    await rm(base, { recursive: true, force: true })
  }
})

test('filenameFromDisposition decodes GBK and UTF-8 header filenames', () => {
  // 站点直接写 GBK 字节（undici 按 latin1 给出这些字节）。
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x7a, 0x69, 0x70]).toString('latin1')
  assert.equal(lib.files.filenameFromDisposition(`attachment; filename="${gbk}"`), '中文.zip')
  const utf8 = Buffer.from('中文.zip', 'utf8').toString('latin1')
  assert.equal(lib.files.filenameFromDisposition(`attachment; filename="${utf8}"`), '中文.zip')
  // RFC 5987 的 filename* 仍然优先。
  assert.equal(
    lib.files.filenameFromDisposition("attachment; filename=\"fallback.zip\"; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip"),
    '中文.zip',
  )
  assert.equal(lib.files.filenameFromDisposition('attachment; filename="plain.zip"'), 'plain.zip')
})

test('DoH resolver reads A/AAAA from a JSON endpoint and caches them', async () => {
  const queries = []
  const { server, port } = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const name = url.searchParams.get('name')
    const type = url.searchParams.get('type')
    queries.push(`${type}:${name}`)
    const answers = type === '1'
      ? [{ type: 1, TTL: 60, data: '203.0.113.7' }]
      : type === '28'
        ? [{ type: 28, TTL: 60, data: '2001:db8::7' }]
        : [{ type: 5, TTL: 60, data: 'edge.example.test.' }]
    res.writeHead(200, { 'content-type': 'application/dns-json' }).end(JSON.stringify({ Status: 0, Answer: answers }))
  })
  try {
    const resolver = lib.doh.createDohResolver({ provider: 'alidns', endpoint: `http://127.0.0.1:${port}/dns-query` })
    const first = await resolver.resolve('www.example.test')
    assert.deepEqual(first.addresses.map((entry) => entry.address), ['203.0.113.7', '2001:db8::7'])
    assert.equal(first.cached, false)
    const second = await resolver.resolve('www.example.test')
    assert.equal(second.cached, true)
    assert.equal(queries.length, 2, 'cached resolve must not query again')
    const cname = await resolver.query('cdn.example.test', 'CNAME')
    assert.equal(cname.records[0].type, 'CNAME')
    assert.equal(cname.records[0].data, 'edge.example.test.')
    await assert.rejects(resolver.query('cdn.example.test', 'NOPE'), /不支持的记录类型/)
  } finally {
    await close(server)
  }
})

test('an unreachable DoH provider names itself and suggests an alternative', async () => {
  // 本机网络经常只挡住某一个提供商（Cloudflare 最典型），裸的 fetch failed 帮不上忙。
  const resolver = lib.doh.createDohResolver({ provider: 'cloudflare', endpoint: 'http://127.0.0.1:1/dns-query', timeoutMs: 3000 })
  await assert.rejects(
    () => resolver.query('example.test', 'A'),
    (error) => {
      assert.match(error.message, /cloudflare/)
      assert.match(error.message, /alidns/)
      return true
    },
  )
})

test('doh_lookup tool validates input and short-circuits IP literals', async () => {
  const tool = makeDohTool({ dohProvider: 'alidns' })
  const missing = await tool.execute({})
  assert.equal(missing.ok, false)
  assert.match(missing.error, /缺少 name/)
  const ip = await tool.execute({ name: '203.0.113.9', type: 'both' })
  assert.equal(ip.ok, true)
  assert.deepEqual(ip.addresses, [{ name: '203.0.113.9', address: '203.0.113.9', family: 4 }])
  const tooMany = await tool.execute({ names: Array.from({ length: 21 }, (_, index) => `h${index}.test`) })
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.error, /最多解析 20 个域名/)
})

test('http_probe tool reports size and range support without downloading the body', async () => {
  const body = Buffer.alloc(2048, 3)
  let downloaded = 0
  const { server, port } = await listen((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
      return
    }
    if (range === null) {
      downloaded += body.length
      res.writeHead(200, { 'content-length': String(body.length) }).end(body)
      return
    }
    downloaded += 1
    res.writeHead(206, { 'content-length': '1', 'content-range': `bytes 0-0/${body.length}` }).end(body.subarray(0, 1))
  })
  try {
    const tool = makeProbeTool({ dohProvider: 'alidns' })
    const result = await tool.execute({ url: `http://127.0.0.1:${port}/f.bin` })
    assert.equal(result.ok, true)
    assert.equal(result.size, body.length)
    assert.equal(result.ranges, true)
    assert.equal(downloaded, 0, 'probing must not read the body')
    const invalid = await tool.execute({})
    assert.equal(invalid.ok, false)
    assert.match(invalid.error, /缺少 url/)
  } finally {
    await close(server)
  }
})

// ---------------------------------------------------------------------------
// 回归测试：全量审查发现的 P0/P1/P2 问题
// ---------------------------------------------------------------------------

/** 真实 Manager，用最简配置；调用方负责 dispose。 */
function makeManager(directory, overrides = {}) {
  return new Downloader({
    directory,
    threads: 4,
    maxConnections: 8,
    largeFileMb: 16,
    minThreadMb: 4,
    minThreadEnabled: true,
    agentAutonomy: true,
    autoThreads: true,
    fingerprintResume: true,
    silentEnabled: true,
    loadAdaptive: false,
    siteAdaptive: false,
    rateLimitBytes: 0,
    settingsPath: '',
    tasksPath: '',
    ...overrides,
  })
}

test('416 responses fail fast instead of spinning requests forever', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-416-'))
  const body = Buffer.alloc(2048 * 1024, 4)
  let rangeRequests = 0
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
      return
    }
    rangeRequests += 1
    res.writeHead(416, { 'content-range': `bytes */${body.length}` }).end()
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { threads: 2, singleThread: false })
    task.status = 'probing'
    await task.run().catch(() => {})
    // 允许重建分片一次，但绝不允许无限空转（修复前是每秒几十次、永不结束）。
    assert.ok(rangeRequests <= 12, `Range 请求数应有限，实际 ${rangeRequests}`)
    assert.equal(task.status, 'failed')
    assert.match(task.error, /416/)
  } finally {
    server.closeAllConnections?.()
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a stalled response body times out and gives the connection slot back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-stall-'))
  const body = Buffer.alloc(1024 * 1024, 5)
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
      return
    }
    res.writeHead(206, { 'content-length': '1024', 'content-range': `bytes 0-1023/${body.length}` })
    res.write(body.subarray(0, 4))
    // 之后既不发数据也不结束：模拟半死连接。
  })
  try {
    const manager = stubManager(directory, { ioIdleTimeoutMs: 250 })
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { threads: 2, singleThread: false })
    task.status = 'probing'
    const startedAt = Date.now()
    await task.run().catch(() => {})
    assert.equal(task.status, 'failed')
    assert.ok(Date.now() - startedAt < 15_000, '空闲超时必须及时生效')
    assert.match(task.error, /超时|提前结束|HTTP/)
    assert.equal(manager.slots.used, 0, '连接槽必须归还')
  } finally {
    server.closeAllConnections?.()
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('pause then immediate resume leaves one run, no stale error, exact bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-race-'))
  const body = Buffer.alloc(1024 * 1024, 6)
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
      return
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = match === null ? 0 : Number(match[1])
    const end = match === null || match[2] === '' ? body.length - 1 : Number(match[2])
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${body.length}`,
    })
    const slice = body.subarray(start, end + 1)
    let offset = 0
    const timer = setInterval(() => {
      if (offset >= slice.length) {
        clearInterval(timer)
        res.end()
        return
      }
      res.write(slice.subarray(offset, offset + 64 * 1024))
      offset += 64 * 1024
    }, 15)
    res.on('close', () => clearInterval(timer))
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { threads: 2, singleThread: false })
    task.status = 'probing'
    const firstRun = task.run().catch(() => {})
    await new Promise((done) => setTimeout(done, 150))
    task.pause()
    task.resume()
    await firstRun
    for (let index = 0; index < 400 && task.status === 'downloading'; index += 1) {
      await new Promise((done) => setTimeout(done, 25))
    }
    assert.equal(task.status, 'completed')
    assert.equal(task.error, '', '旧轮不得把 "file closed" 之类错误留在任务上')
    assert.equal(task.receivedBytes, body.length)
    const onDisk = await readFile(task.path)
    assert.equal(onDisk.length, body.length)
  } finally {
    server.closeAllConnections?.()
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('pausing during the probe then resuming leaves exactly one live run', async () => {
  // run()（探测→建文件→建分片）以前不持有 run 令牌：暂停落在探测阶段时 resume() 会再起
  // 一个 run()，两个 run() 各自打开 .mtd-part、各自覆盖 chunks，先跑完的那个 rename 掉临时
  // 文件，另一个再 open 就是 ENOENT。用慢 HEAD 稳定地把暂停压在探测阶段。
  const directory = await mkdtemp(join(tmpdir(), 'mtd-probe-race-'))
  const body = Buffer.alloc(512 * 1024, 7)
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
        }
      }, 200)
      return
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = match === null ? 0 : Number(match[1])
    const end = match === null || match[2] === '' ? body.length - 1 : Number(match[2])
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${body.length}`,
    })
    res.end(body.subarray(start, end + 1))
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { threads: 2, singleThread: false })
    task.status = 'probing'
    const firstRun = task.run().catch(() => {})
    await new Promise((done) => setTimeout(done, 40))
    task.pause()
    task.resume()
    await firstRun
    for (let index = 0; index < 400 && task.status !== 'completed' && task.status !== 'failed'; index += 1) {
      await new Promise((done) => setTimeout(done, 25))
    }
    assert.equal(task.error, '', '探测阶段暂停再恢复不得留下错误')
    assert.equal(task.status, 'completed')
    const onDisk = await readFile(task.path)
    assert.equal(onDisk.length, body.length)
    assert.deepEqual(onDisk, body)
  } finally {
    server.closeAllConnections?.()
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('resuming after the part file disappeared restarts instead of failing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-part-gone-'))
  const body = Buffer.alloc(512 * 1024, 8)
  const { server, port } = await listen((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' }).end()
      return
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = match === null ? 0 : Number(match[1])
    const end = match === null || match[2] === '' ? body.length - 1 : Number(match[2])
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${body.length}`,
    })
    const slice = body.subarray(start, end + 1)
    let offset = 0
    const timer = setInterval(() => {
      if (offset >= slice.length) {
        clearInterval(timer)
        res.end()
        return
      }
      res.write(slice.subarray(offset, offset + 32 * 1024))
      offset += 32 * 1024
    }, 20)
    res.on('close', () => clearInterval(timer))
  })
  try {
    const manager = stubManager(directory)
    const task = makeTask(manager, `http://127.0.0.1:${port}/file.bin`, { threads: 2, singleThread: false })
    task.status = 'probing'
    const firstRun = task.run().catch(() => {})
    await new Promise((done) => setTimeout(done, 120))
    task.pause()
    await firstRun
    await unlink(task.partPath).catch(() => {})
    task.resume()
    for (let index = 0; index < 400 && task.status !== 'completed' && task.status !== 'failed'; index += 1) {
      await new Promise((done) => setTimeout(done, 25))
    }
    assert.equal(task.error, '', '临时文件消失应触发从头重下，而不是 ENOENT')
    assert.equal(task.status, 'completed')
    assert.deepEqual(await readFile(task.path), body)
  } finally {
    server.closeAllConnections?.()
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('restoreTasks brings unfinished tasks back as paused, keeping their settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-restore-'))
  const tasksPath = join(directory, 'tasks.json')
  const path = join(directory, 'r.bin')
  const partPath = `${path}.mtd-part`
  await writeFile(partPath, Buffer.alloc(1024, 7))
  await writeFile(tasksPath, JSON.stringify({
    version: 1,
    tasks: [{
      id: 'abc12345',
      urls: ['https://example.test/r.bin'],
      dir: directory,
      filename: 'r.bin',
      requestedName: 'r.bin',
      path,
      partPath,
      totalBytes: 2048,
      chunks: [{ start: 0, end: 2047, cursor: 1024, total: 2048 }],
      etag: '"v1"',
      lastModified: '',
      headers: { referer: 'https://example.test/' },
      checksum: null,
      origin: 'user',
      doh: true,
      dohProvider: 'tencent',
      github: false,
      forceDisplay: true,
      threads: 4,
      threadsExplicit: true,
      singleThread: false,
      createdAt: Date.now(),
    }],
  }))
  try {
    const manager = makeManager(directory, { tasksPath, siteAdaptive: false, loadAdaptive: false })
    try {
      const task = manager.tasks.get('abc12345')
      assert.ok(task !== undefined, '未完成任务必须被恢复（修复前一条也恢复不出来）')
      assert.equal(task.status, 'paused')
      assert.equal(task.receivedBytes, 1024)
      assert.equal(task.origin, 'user', 'origin 丢了会让用户任务被当成静默任务')
      assert.equal(task.forceDisplay, true)
      assert.equal(task.doh, true)
      assert.equal(task.dohProvider, 'tencent')
    } finally {
      manager.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('clean releases the reserved file name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-clean-'))
  try {
    const manager = makeManager(directory)
    try {
      const task = new DownloadTask(manager, {
        id: 't1',
        urls: ['https://example.test/a.bin'],
        dir: directory,
        filename: 'a.bin',
        threads: 4,
        origin: 'agent',
      })
      task.path = join(directory, 'a.bin')
      task.partPath = `${task.path}.mtd-part`
      task.status = 'failed'
      manager.tasks.set('t1', task)
      manager.reservedNames.add(task.path)
      assert.equal(manager.clean(), 1)
      assert.equal(manager.reservedNames.has(task.path), false, 'clean 后同名下载不该变成 "a (1).bin"')
    } finally {
      manager.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('pause stops a queued task and resume rejects terminal states', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-queued-'))
  try {
    const manager = makeManager(directory)
    try {
      const task = new DownloadTask(manager, {
        id: 'q1',
        urls: ['https://example.test/q.bin'],
        dir: directory,
        filename: 'q.bin',
        threads: 4,
        origin: 'agent',
      })
      task.status = 'queued'
      manager.tasks.set('q1', task)
      const paused = await manager.control('q1', 'pause')
      assert.equal(paused.task.status, 'paused', '排队中的任务暂停必须真的停下来')
      task.status = 'canceled'
      await assert.rejects(manager.control('q1', 'resume'), /已取消/)
    } finally {
      manager.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('filenameFromUrl tolerates malformed percent-encoding', () => {
  const fromBad = lib.files.filenameFromUrl(new URL('http://host/a%zz.bin'))
  assert.equal(fromBad, 'a%zz.bin')
  assert.equal(lib.files.filenameFromUrl(new URL('http://host/')), 'download.bin')
})

test('siteKeyForUrl keeps multi-tenant hosts separate', () => {
  assert.notEqual(siteKeyForUrl('https://a.github.io/x'), siteKeyForUrl('https://b.github.io/y'))
  assert.notEqual(
    siteKeyForUrl('https://bucket1.s3.amazonaws.com/f'),
    siteKeyForUrl('https://bucket2.s3.amazonaws.com/f'),
  )
  assert.equal(siteKeyForUrl('https://bucket1.s3.amazonaws.com/f'), 'bucket1.s3.amazonaws.com')
})

test('retryDelay accepts a Retry-After duration in milliseconds', () => {
  assert.equal(retryDelay(1, 2000), 2000)
  assert.ok(retryDelay(1, 0) >= 500)
})

test('escalationTarget lifts the auto ladder but keeps explicit threads fixed', () => {
  const manager = stubManager('C:/tmp')
  const task = makeTask(manager, 'http://127.0.0.1:1/a.bin')
  task.chunks = [{ start: 0, end: 8 * MB - 1, cursor: 0, total: 8 * MB }]
  task.planThreads = 4
  task.threads = 4
  task.threadsExplicit = false
  assert.equal(task.escalationTarget(), 8, 'auto ladder may climb to the escalation ceiling')

  task.threadsExplicit = true
  assert.equal(task.escalationTarget(), 4, 'explicit threads stay exactly as requested')
  task.threadsExplicit = false
  task.threads = 2
  manager.autoThreads = false
  assert.equal(task.escalationTarget(), 2, 'autoThreads off keeps the configured count')
  manager.autoThreads = true

  task.planThreads = 12
  assert.equal(task.escalationTarget(), 12, 'a plan above the ceiling is not cut down')
  task.chunks = [{ start: 0, end: -1, cursor: 0, total: 1 }]
  assert.equal(task.escalationTarget(), 1, 'single-stream downloads cannot be split')

  task.chunks = [{ start: 0, end: 8 * MB - 1, cursor: 0, total: 8 * MB }]
  task.planThreads = 4
  manager.maxConnections = 6
  assert.equal(task.escalationTarget(), 6, 'the global connection budget still caps the ceiling')
})

test('maybeEscalate splits only the remaining tail and never loses a byte', () => {
  const manager = stubManager('C:/tmp')
  const task = makeTask(manager, 'http://127.0.0.1:1/a.bin')
  task.status = 'downloading'
  task.totalBytes = 64 * MB
  task.receivedBytes = 8 * MB
  task.threads = 4
  task.planThreads = 4
  task.chunks = [0, 1, 2, 3].map((index) => ({
    start: index * 16 * MB,
    end: index * 16 * MB + 16 * MB - 1,
    cursor: index === 0 ? 8 * MB : 0,
    total: 16 * MB,
  }))
  // 每条连接 200 KB/s：低于「单连接被限速」的判定线，允许爬升。
  task.speed = 4 * 200 * 1024
  task.expandPolicy = task.expandPolicy.bind(task)
  const spawned = []
  task.spawnChunk = (chunk) => spawned.push(chunk)

  const before = task.chunks.map((chunk) => [chunk.start + chunk.cursor, chunk.end])
  const beforeBytes = before.reduce((sum, [start, end]) => sum + (end - start + 1), 0)
  assert.equal(task.maybeEscalate(), true)
  assert.equal(task.chunks.length, 5)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0], task.chunks[4])

  const after = task.chunks
    .map((chunk) => [chunk.start + chunk.cursor, chunk.end])
    .filter(([start, end]) => end >= start)
  const afterBytes = after.reduce((sum, [start, end]) => sum + (end - start + 1), 0)
  assert.equal(afterBytes, beforeBytes, 'escalation must not change how many bytes are left')
  // 切出来的两段必须完全落在原来的一个分片里，且首尾相接，不能重叠也不能有空洞。
  const sorted = after.slice().sort((left, right) => left[0] - right[0])
  for (let index = 1; index < sorted.length; index += 1) {
    assert.equal(sorted[index][0], sorted[index - 1][1] + 1, 'ranges must tile without gaps or overlap')
  }
  assert.equal(sorted[0][0], before[0][0])
  assert.equal(sorted[sorted.length - 1][1], 64 * MB - 1)
})

test('maybeEscalate stays put when bandwidth is fine, late, throttled or budget-busy', async () => {
  const make = (overrides = {}) => {
    const manager = stubManager('C:/tmp', overrides.manager ?? {})
    const task = makeTask(manager, 'http://127.0.0.1:1/a.bin')
    task.status = 'downloading'
    task.totalBytes = 64 * MB
    task.receivedBytes = 8 * MB
    task.threads = 4
    task.planThreads = 4
    task.chunks = [0, 1, 2, 3].map((index) => ({
      start: index * 16 * MB,
      end: index * 16 * MB + 16 * MB - 1,
      cursor: 0,
      total: 16 * MB,
    }))
    task.speed = 4 * 3 * MB
    task.spawnChunk = () => {}
    return task
  }

  // 每条连接已经有 3 MB/s：瓶颈不在连接数，加连接只会互相抢。
  assert.equal(make().maybeEscalate(), false)
  // 收尾阶段：只要还有空闲连接、尾巴又还够切，就接着用 —— 先跑完的分片交还的连接不该闲着。
  const late = make()
  late.receivedBytes = 40 * MB
  late.speed = 4 * 100 * 1024
  assert.equal(late.maybeEscalate(), true, 'late but still splittable: idle connections must keep working')
  // 尾巴已经不够分成两个像样的分片时收手。
  const tail = make()
  tail.receivedBytes = 64 * MB - 400 * 1024
  tail.speed = 4 * 100 * 1024
  tail.chunks = [{ start: 64 * MB - 400 * 1024, end: 64 * MB - 1, cursor: 0, total: 400 * 1024 }]
  assert.equal(tail.maybeEscalate(), false, 'a 400 KB tail is not worth another request')
  // 没有速度采样（一直没数据进来）时不扩容：没有单连接被限速的证据。
  const noSpeed = make()
  noSpeed.speed = 0
  assert.equal(noSpeed.maybeEscalate(), false, 'without throughput evidence there is nothing to fix')
  // 站点已被风控降档：此时瓶颈是站点配额。
  const throttled = make()
  throttled.speed = 4 * 100 * 1024
  throttled.manager.siteGovernor.penalize('http://127.0.0.1:1/a.bin', 403)
  assert.equal(throttled.maybeEscalate(), false)
  // 全局预算正被别人用满：不能抢别人的连接。
  const busy = make({ manager: { slots: new ConnectionSlots(1) } })
  busy.speed = 4 * 100 * 1024
  const release = await busy.manager.slots.acquire()
  assert.equal(busy.maybeEscalate(), false)
  release()
  // 空闲分片都不够大（每片只剩 300 KB）时不切。
  const small = make()
  small.speed = 4 * 100 * 1024
  small.chunks = small.chunks.map((chunk) => ({ ...chunk, end: chunk.start + 300 * 1024 - 1, total: 300 * 1024 }))
  assert.equal(small.maybeEscalate(), false)
})

test('a slow-per-connection server grows the chunk count while the task runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-grow-'))
  const size = 12 * MB
  const body = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) body[index] = (index * 31 + 7) % 256
  const expected = createHash('sha256').update(body).digest('hex')
  const delay = (ms) => new Promise((done) => setTimeout(done, ms))
  const { server, port } = await listen(async (req, res) => {
    const base = { 'accept-ranges': 'bytes', etag: '"grow-v1"', 'content-type': 'application/octet-stream' }
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...base, 'content-length': String(size) }).end()
      return
    }
    let start = 0
    let end = size - 1
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (match !== null) {
      start = Number(match[1])
      end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
      res.writeHead(206, {
        ...base,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
      })
    } else {
      res.writeHead(200, { ...base, 'content-length': String(size) })
    }
    // 每条连接约 1 MB/s：真实站点的「单连接限速」就是这个形状，
    // 4 条连接只能跑到 4 MB/s，多加连接才拿得到更多带宽。
    let offset = start
    while (offset <= end && !res.destroyed) {
      const stop = Math.min(end, offset + 64 * 1024 - 1)
      res.write(body.subarray(offset, stop + 1))
      offset = stop + 1
      await delay(60)
    }
    res.end()
  })
  const manager = new Downloader({
    directory,
    threads: 4,
    maxConnections: 16,
    largeFileMb: 16,
    minThreadMb: 4,
    minThreadEnabled: true,
    agentAutonomy: true,
    autoThreads: true,
    fingerprintResume: true,
    silentEnabled: true,
    loadAdaptive: false,
    siteAdaptive: true,
    rateLimitBytes: 0,
    settingsPath: '',
    tasksPath: '',
  })
  manager.expandIntervalMs = 250
  manager.expandSlowPerConnectionBps = 4 * MB
  manager.expandProgressMax = 0.9
  manager.expandMinRemainingBytes = 1 * MB
  try {
    await manager.add({ url: `http://127.0.0.1:${port}/grow.bin`, directory, filename: 'grow.bin' })
    const task = [...manager.tasks.values()][0]
    const started = Date.now() + 30_000
    while (task.planThreads === 0 && Date.now() < started) await delay(25)
    assert.equal(task.planThreads, 4, 'a 12 MB file starts on the 4-connection rung')
    // 并发上限管的是同时在用的连接数，不是分片条数：收尾让位会让条数超过上限。
    let peakConnections = 0
    let peakChunks = 0
    const deadline = Date.now() + 30_000
    while (task.status === 'probing' || task.status === 'queued' || task.status === 'downloading') {
      peakConnections = Math.max(peakConnections, task.chunks.filter((chunk) => chunk.inflight === true).length)
      peakChunks = Math.max(peakChunks, task.chunks.length)
      if (Date.now() > deadline) throw new Error('download did not finish in time')
      await delay(10)
    }
    assert.equal(task.status, 'completed', `expected completion, got ${task.status}: ${task.error}`)
    assert.ok(task.expansions > 0, 'the task should have grown past its starting chunk count')
    assert.ok(peakConnections > 4, `expected more than 4 concurrent connections, peaked at ${peakConnections}`)
    assert.ok(peakConnections <= 8, `concurrent connections are capped at 8, peaked at ${peakConnections}`)
    assert.ok(peakChunks >= peakConnections, 'chunk rows may outnumber connections but never the other way')
    // 收尾后展示的线程数必须是「真正用过的并发」，而不是分片条数。
    const final = task.snapshot()
    assert.equal(final.threads, peakConnections, 'a finished task reports the connections it actually used')
    assert.ok(final.threads <= 8, `the panel must never show more threads than the cap, saw ${final.threads}`)
    const saved = await readFile(join(directory, 'grow.bin'))
    assert.equal(saved.length, size)
    assert.equal(createHash('sha256').update(saved).digest('hex'), expected, 'hot splitting must not corrupt bytes')
  } finally {
    manager.dispose()
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('splitFriendly tracks whether climbing is still possible', () => {
  const manager = stubManager('C:/tmp')
  const task = makeTask(manager, 'http://127.0.0.1:1/a.bin')
  task.status = 'downloading'
  task.totalBytes = 64 * MB
  task.receivedBytes = 4 * MB
  task.threads = 4
  task.planThreads = 4
  task.chunks = [0, 1, 2, 3].map((index) => ({
    start: index * 16 * MB,
    end: index * 16 * MB + 16 * MB - 1,
    cursor: 0,
    total: 16 * MB,
  }))
  assert.equal(task.splitFriendly(), true, 'auto mode below the ceiling may split pieces up')

  task.threadsExplicit = true
  assert.equal(task.splitFriendly(), false, 'explicit threads never climb, so pieces stay whole')
  task.threadsExplicit = false

  task.receivedBytes = 50 * MB
  assert.equal(task.splitFriendly(), true, 'the endgame still needs split points for idle connections')
  task.receivedBytes = 64 * MB - 400 * 1024
  assert.equal(task.splitFriendly(), false, 'a sub-half-megabyte tail cannot be split any more')
  task.receivedBytes = 4 * MB

  task.chunks[1].cursor = task.chunks[1].total
  task.chunks[2].cursor = task.chunks[2].total
  task.chunks[3].cursor = task.chunks[3].total
  assert.equal(task.liveChunks(), 1)
  assert.equal(task.splitFriendly(), true, 'finished chunks must not count against the ceiling')

  manager.threadEscalation = false
  task.chunks.forEach((chunk) => { chunk.cursor = 0 })
  assert.equal(task.splitFriendly(), false, 'escalation can be switched off entirely')
})

test('a task that cannot climb uses one request per chunk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-piece-'))
  const size = 8 * MB
  const body = Buffer.alloc(size, 3)
  let gets = 0
  const { server, port } = await listen((req, res) => {
    const base = { 'accept-ranges': 'bytes', etag: '"piece-v1"', 'content-type': 'application/octet-stream' }
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...base, 'content-length': String(size) }).end()
      return
    }
    gets += 1
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (match === null) {
      res.writeHead(200, { ...base, 'content-length': String(size) }).end(body)
      return
    }
    const start = Number(match[1])
    const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
    res.writeHead(206, {
      ...base,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
    }).end(body.subarray(start, end + 1))
  })
  const manager = new Downloader({
    directory,
    threads: 4,
    maxConnections: 16,
    largeFileMb: 16,
    minThreadMb: 1,
    minThreadEnabled: true,
    agentAutonomy: true,
    autoThreads: true,
    fingerprintResume: true,
    silentEnabled: true,
    loadAdaptive: false,
    siteAdaptive: false,
    rateLimitBytes: 0,
    settingsPath: '',
    tasksPath: '',
  })
  try {
    await manager.add({ url: `http://127.0.0.1:${port}/piece.bin`, directory, filename: 'piece.bin', threads: 4 })
    const task = [...manager.tasks.values()][0]
    const deadline = Date.now() + 15_000
    while (task.status !== 'completed' && task.status !== 'failed') {
      if (Date.now() > deadline) throw new Error('download did not finish in time')
      await new Promise((done) => setTimeout(done, 25))
    }
    assert.equal(task.status, 'completed', task.error)
    // 显式 4 线程：不爬升，每个分片（2 MB）一个请求就够，不应被切细成好几段。
    assert.equal(gets, 4, `expected one request per chunk, saw ${gets}`)
  } finally {
    manager.dispose()
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})
