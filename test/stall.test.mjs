import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../index.js'

const {
  DownloadTask, RateLimiter, ConnectionSlots, SiteGovernor,
} = __test

const KB = 1024
const MB = 1024 * KB

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
    siteAdaptive: false,
    siteGovernor: new SiteGovernor(false),
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
    id: 'stall-task',
    urls: [url],
    dir: manager.root,
    filename: '',
    threads: 1,
    threadsExplicit: true,
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

async function close(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(() => resolve()))
}

function rangeOf(request, total) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  if (match === null) return { start: 0, end: total - 1, ranged: false }
  const start = Number(match[1])
  const end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1)
  return { start, end, ranged: true }
}

/** 每 tickMs 只吐一格字节的半死连接：连接不断开，正文永远发不完。 */
function trickle(response, body, start, end, tickMs) {
  let cursor = start
  const timer = setInterval(() => {
    if (cursor > end || response.destroyed) {
      clearInterval(timer)
      return
    }
    response.write(body.subarray(cursor, cursor + 1))
    cursor += 1
  }, tickMs)
  response.on('close', () => clearInterval(timer))
}

async function waitFor(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time')
    await new Promise((done) => setTimeout(done, 50))
  }
}

test('the stall floor follows a rate limit the user set themselves', () => {
  const manager = stubManager('/tmp', {
    stallWatchdog: true,
    stallWindowMs: 60_000,
    stallMinBytes: 64 * KB,
    rateLimitBytes: 512,
  })
  const task = makeTask(manager, 'https://example.test/a.bin')
  // 用户把全局限速压到 512 B/s：60 秒窗口本来就只该收到 30 KB，
  // 判停滞的下限要跟着预期吞吐让下来（一半 = 15 KB），否则每个任务都会被误判。
  assert.equal(task.stallFloorBytes(60_000), Math.round(512 * 60 * 0.5))
  manager.rateLimitBytes = 0
  assert.equal(task.stallFloorBytes(60_000), 64 * KB)
})

test('no stall judgement while the task is only waiting for a connection slot', () => {
  const manager = stubManager('/tmp', {
    stallWatchdog: true,
    stallWindowMs: 1000,
    stallMinBytes: 1024,
    stallMaxResets: 2,
  })
  const task = makeTask(manager, 'https://example.test/a.bin')
  task.status = 'downloading'
  task.totalBytes = 10 * MB
  task.receivedBytes = 0
  // 没有在途分片（等在排队/冷却）：这不算停滞。
  task.checkStall(1000)
  task.checkStall(5000)
  assert.equal(task.stallResets, 0)
  assert.equal(task.stallNote, '')
})

test('resuming after a long pause does not count the paused time as a stall', () => {
  const manager = stubManager('/tmp', {
    stallWatchdog: true,
    stallWindowMs: 1000,
    stallMinBytes: 1024,
    stallMaxResets: 2,
  })
  const task = makeTask(manager, 'https://example.test/a.bin')
  task.status = 'downloading'
  task.totalBytes = 10 * MB
  task.chunks = [{ start: 0, end: 100, cursor: 0, inflight: true }]
  // 暂停了十分钟：窗口起点还是旧的，不重设就会把这段时间算成停滞。
  task.stallWindowAt = Date.now() - 10 * 60_000
  task.startSampler()
  task.checkStall(Date.now())
  task.stopSampler()
  assert.equal(task.stallResets, 0)
  assert.equal(task.stallNote, '')
})

test('the watchdog swaps a half-dead connection and the file still verifies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-stall-swap-'))
  const body = Buffer.alloc(512 * KB, 9)
  const etag = '"stall-v1"'
  let dataRequests = 0
  const { server, port } = await listen((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes', etag }).end()
      return
    }
    dataRequests += 1
    const { start, end, ranged } = rangeOf(request, body.length)
    const headers = {
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      etag,
      'content-type': 'application/octet-stream',
    }
    if (ranged) headers['content-range'] = `bytes ${start}-${end}/${body.length}`
    response.writeHead(ranged ? 206 : 200, headers)
    if (dataRequests === 1) {
      // 第一条连接是半死的：200ms 一个字节，看门狗必须把它换掉。
      trickle(response, body, start, end, 200)
      return
    }
    response.end(body.subarray(start, end + 1))
  })
  try {
    const manager = stubManager(directory, {
      stallWatchdog: true,
      stallWindowMs: 300,
      stallMinBytes: 16 * KB,
      stallMaxResets: 2,
    })
    const task = makeTask(manager, `http://127.0.0.1:${port}/slow.bin`)
    task.status = 'probing'
    await task.run()
    assert.equal(task.status, 'completed', task.error)
    assert.ok(task.stallResets >= 1, `expected the watchdog to swap the connection, got ${task.stallResets}`)
    const written = await readFile(task.path)
    assert.equal(written.length, body.length)
    assert.equal(createHash('sha256').update(written).digest('hex'), createHash('sha256').update(body).digest('hex'))
  } finally {
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a permanently trickling remote is marked slow instead of failing the task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-stall-slow-'))
  const body = Buffer.alloc(256 * KB, 3)
  const etag = '"stall-slow"'
  const { server, port } = await listen((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes', etag }).end()
      return
    }
    const { start, end, ranged } = rangeOf(request, body.length)
    const headers = {
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      etag,
      'content-type': 'application/octet-stream',
    }
    if (ranged) headers['content-range'] = `bytes ${start}-${end}/${body.length}`
    response.writeHead(ranged ? 206 : 200, headers)
    trickle(response, body, start, end, 100)
  })
  let manager = null
  let task = null
  try {
    manager = stubManager(directory, {
      stallWatchdog: true,
      stallWindowMs: 300,
      stallMinBytes: 16 * KB,
      stallMaxResets: 1,
    })
    task = makeTask(manager, `http://127.0.0.1:${port}/forever.bin`)
    task.status = 'probing'
    task.run().catch(() => undefined)
    await waitFor(() => task.stallSlow === true)
    assert.equal(task.status, 'downloading', '极慢不该判失败，只是停止自动换连接')
    assert.match(task.stallNote, /极慢/)
    const snapshot = task.snapshot()
    assert.equal(snapshot.slow, true)
    assert.equal(snapshot.stallResets, 1)
    // 速度低到 1 KB/s 以下时不报「约剩两天」这种 ETA。
    assert.equal(snapshot.etaSeconds, undefined)
  } finally {
    if (task !== null) await task.cancel().catch(() => undefined)
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('turning the watchdog off keeps the old behaviour: a trickle is never judged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-stall-off-'))
  const body = Buffer.alloc(256 * KB, 4)
  const etag = '"stall-off"'
  const { server, port } = await listen((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes', etag }).end()
      return
    }
    const { start, end, ranged } = rangeOf(request, body.length)
    const headers = {
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      etag,
      'content-type': 'application/octet-stream',
    }
    if (ranged) headers['content-range'] = `bytes ${start}-${end}/${body.length}`
    response.writeHead(ranged ? 206 : 200, headers)
    trickle(response, body, start, end, 100)
  })
  let task = null
  try {
    const manager = stubManager(directory, {
      stallWatchdog: false,
      stallWindowMs: 300,
      stallMinBytes: 16 * KB,
      stallMaxResets: 2,
    })
    task = makeTask(manager, `http://127.0.0.1:${port}/off.bin`)
    task.status = 'probing'
    task.run().catch(() => undefined)
    await new Promise((done) => setTimeout(done, 2500))
    assert.equal(task.stallResets, 0)
    assert.equal(task.stallNote, '')
  } finally {
    if (task !== null) await task.cancel().catch(() => undefined)
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
})
