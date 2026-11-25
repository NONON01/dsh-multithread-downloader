/**
 * 插件装配层的测试：apply() 注册了什么、dispose 后是否撤干净、路由是否可用。
 *
 * 这里用假 ctx（只实现 tools / webServer / effect / inject），不启动 DSH，
 * 也不会访问外网；pick-directory 只发 probe，不弹真实对话框。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../index.js'

const { apply, TOOL_PARAMETERS, TASK_SCHEMA } = __test

function fakeCtx() {
  const tools = new Map()
  const routes = []
  const effects = []
  const scoped = {
    effect: (factory) => {
      effects.push(factory())
    },
    systemPrompt: { section: () => () => {} },
    skills: { register: () => () => {} },
  }
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      get(name) {
        return tools.get(name)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect(factory) {
      effects.push(factory())
    },
    inject(_names, callback) {
      callback(scoped)
    },
  }
  return { ctx, tools, routes, effects }
}

function fakeRequest(body, headers = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))])
  request.method = 'POST'
  request.headers = { host: '127.0.0.1:64967', 'content-type': 'application/json', ...headers }
  request.socket = { remoteAddress: '127.0.0.1' }
  return request
}

function fakeResponse() {
  const response = {
    status: 0,
    headers: null,
    text: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(text = '') {
      this.text = String(text)
      return this
    },
  }
  return response
}

async function callRoute(routes, path, body) {
  const route = routes.find((entry) => entry.path === path)
  assert.ok(route !== undefined, `路由必须注册：${path}`)
  const response = fakeResponse()
  await route.handler(fakeRequest(body), response)
  return { status: response.status, body: JSON.parse(response.text) }
}

test('apply registers three tools and seven routes, and dispose removes them all', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-apply-'))
  const previousProfile = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = directory
  const { ctx, tools, routes, effects } = fakeCtx()
  try {
    apply(ctx, { directory, loadAdaptive: false, siteAdaptive: false })
    assert.deepEqual([...tools.keys()].sort(), ['doh_lookup', 'downloader', 'http_probe'])
    assert.deepEqual(
      routes.map((route) => route.path).sort(),
      ['/api/mtd/add', '/api/mtd/browse', '/api/mtd/control', '/api/mtd/pick-directory', '/api/mtd/settings', '/api/mtd/state', '/api/mtd/summary'],
    )
    for (const dispose of effects) dispose()
    assert.equal(tools.size, 0, 'dispose 后工具表必须清空')
    assert.equal(routes.length, 0, 'dispose 后路由必须撤销')
  } finally {
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    await rm(directory, { recursive: true, force: true })
  }
})

test('pick-directory probes without throwing an undefined reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mtd-pick-'))
  const previousProfile = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = directory
  const { ctx, routes, effects } = fakeCtx()
  try {
    apply(ctx, { directory, loadAdaptive: false, siteAdaptive: false })
    const result = await callRoute(routes, '/api/mtd/pick-directory', { probe: true })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(typeof result.body.native, 'boolean')
    assert.equal(typeof result.body.helper, 'boolean')
    // 修复前这里是 ok:true + error:"electronDialog is not defined"（错误被伪装成成功）。
    assert.doesNotMatch(JSON.stringify(result.body), /is not defined/)
  } finally {
    for (const dispose of effects) dispose()
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    await rm(directory, { recursive: true, force: true })
  }
})

test('tool parameters declare every option the tool actually reads', () => {
  const properties = TOOL_PARAMETERS.properties
  for (const key of [
    'action', 'url', 'urls', 'mirrors', 'headers', 'sha256', 'checksum', 'id',
    'directory', 'filename', 'threads', 'singleThread', 'limit', 'waitSeconds',
    'forceDisplay', 'doh', 'dohProvider', 'github',
  ]) {
    assert.ok(properties[key] !== undefined, `TOOL_PARAMETERS 缺少 ${key}`)
  }
  assert.deepEqual(TOOL_PARAMETERS.required, ['action'])
})

test('task schema declares the fields list actually returns', () => {
  const keys = Object.keys(TASK_SCHEMA.properties)
  for (const key of [
    'remainingBytes', 'etaSeconds', 'visibleInUi', 'origin', 'doh', 'dohProvider',
    'github', 'forceDisplay', 'checksum', 'fingerprint', 'siteKey', 'siteThrottle',
    'riskRetries', 'riskNote',
  ]) {
    assert.ok(keys.includes(key), `TASK_SCHEMA 缺少 ${key}`)
  }
})
