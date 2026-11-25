import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  siteKeyForUrl, cpuPercentBetween, loadStepFor, httpStatusOf, SITE_LEVELS, makeDohTool, makeProbeTool,
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

test('cpuPercentBetween measures busy time between samples', () => {
  assert.equal(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 150, total: 300 }), 50)
  assert.equal(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 }), null)
})

test('LoadGovernor shrinks at once and recovers step by step', () => {
  const governor = new LoadGovernor(16, true)
  assert.equal(governor.observe(20, 30), 16)
  // 高负载：一次到位，不逐步试探
  assert.equal(governor.observe(97, 50), 3)
  assert.equal(governor.level, 'critical')
  // 回落后需要连续两个采样周期才抬一档
  assert.equal(governor.observe(20, 20), 3)
  assert.equal(governor.observe(20, 20), 5)
  assert.equal(governor.observe(20, 20), 5)
  assert.equal(governor.observe(20, 20), 7)
  for (let index = 0; index < 20; index += 1) governor.observe(20, 20)
  assert.equal(governor.limit, 16)
  // 再次高负载仍立即收缩
  assert.equal(governor.observe(88, 30), 6)
  // 关闭自适应时回到用户设定值
  assert.equal(governor.setEnabled(false), 16)
  // 重新开启时按最近一次采样（仍为高负载）立即收缩，而不是先放满
  assert.equal(governor.setEnabled(true), 6)
  governor.observe(20, 20)
  governor.observe(20, 20)
  assert.equal(governor.limit, 8)
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
    assert.equal(manager.effectiveConnections, 2)
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
  // 暂停或速度未知时不给 ETA，避免误导向的 0 / Infinity。
  task.status = 'paused'
  assert.equal(task.snapshot().etaSeconds, undefined)
  task.status = 'downloading'
  task.speed = 0
  assert.equal(task.snapshot().etaSeconds, undefined)
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
