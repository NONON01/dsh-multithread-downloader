import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../index.js'

const { sanitizeHeaders, retryDelay, RateLimiter, probe, fetchWithRedirects, fileSha256 } = __test

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
