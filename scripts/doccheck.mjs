// 文档自检：链接、编码、索引，以及「交接页说的版本/测试数是否与代码一致」。
//
//   npm run doc:check          离线检查（默认）
//   npm run doc:check -- --online   额外核对 npm 与 GitHub Release 是否已是当前版本
//
// 说明：docs/ 不进 npm 包也不进公开仓库，所以这个脚本只服务于本地维护；
// 它退出码非 0 就代表「文档与代码脱节」，改文档或改代码都行，但要在同一次收尾里改完。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const online = process.argv.includes('--online')
const problems = []
const note = (msg) => problems.push(msg)

// ---------- 1. 文档：编码、链接、索引 ----------

const mdFiles = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (name.endsWith('.md')) mdFiles.push(full)
  }
}
walk(root)

let linkCount = 0
for (const file of mdFiles) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(root, file)
  if (text.includes('\uFFFD') || /锛|鐨|涓€|妯″潡/.test(text)) note(`编码损坏 ${rel}`)

  const re = /\[[^\]]*\]\(([^)\s]+)\)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const target = m[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const [pathPart, anchor] = target.split('#')
    const abs = resolve(dirname(file), pathPart)
    if (!existsSync(abs)) {
      note(`断链 ${rel} -> ${target}`)
      continue
    }
    linkCount += 1
    if (anchor) {
      const targetText = readFileSync(abs, 'utf8')
      if (!targetText.includes(anchor)) note(`锚点可疑 ${rel} -> ${target}`)
    }
  }
}

const index = readFileSync(join(root, 'docs', 'DEVELOPMENT.md'), 'utf8')
for (const name of readdirSync(join(root, 'docs', 'dev'))) {
  if (name.endsWith('.md') && !index.includes(name)) note(`未索引 docs/dev/${name}`)
}

// ---------- 2. 交接页与代码：版本、测试数 ----------

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const handover = readFileSync(join(root, 'docs', 'dev', 'handover.md'), 'utf8')

// 交接页 §1 的表格行：| 版本 | 1.5.1 | ... | -> 1.5.1
const row = (text, label) => {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`| ${label} |`))
  return line ? (line.split('|')[2] ?? '').trim().replace(/`/g, '') : null
}

const docVersion = row(handover, '版本')
if (!docVersion) note('交接页 §1 缺少「版本」行')
else if (docVersion !== pkg.version) note(`版本不一致：package.json ${pkg.version} / handover §1 ${docVersion}`)

const testCount = ['host', 'plugin', 'stall'].reduce((sum, name) => {
  const text = readFileSync(join(root, 'test', `${name}.test.mjs`), 'utf8')
  return sum + (text.match(/^\s*(?:test|it)(?:\.\w+)?\s*\(/gm) ?? []).length
}, 0)

const claimed = [
  ['handover §1', row(handover, '测试'), /(\d+)/],
  ['testing.md', readFileSync(join(root, 'docs', 'dev', 'testing.md'), 'utf8'), /\*\*(\d+) 项全绿\*\*/],
  ['release.md', readFileSync(join(root, 'docs', 'dev', 'release.md'), 'utf8'), /#\s*(\d+) 项全绿/],
]
for (const [where, source, re] of claimed) {
  const hit = typeof source === 'string' ? source.match(re) : null
  if (!hit) note(`${where} 里找不到测试计数（期望格式：${re}）`)
  else if (Number(hit[1]) !== testCount) note(`测试数不一致：实际 ${testCount} / ${where} 写的是 ${hit[1]}`)
}

// §7 交接日志必须出现过当前版本
const logSection = handover.split('## 7.')[1] ?? ''
if (!logSection.includes(pkg.version)) note(`交接日志 §7 没有 ${pkg.version} 的记录`)

// ---------- 3. 可选：双通道是否已发布 ----------

if (online) {
  const get = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`${res.status} ${url}`)
    return res.json()
  }
  const npmName = pkg.name
  try {
    const meta = await get(`https://registry.npmjs.org/${npmName}/latest`)
    if (meta.version !== pkg.version) note(`npm latest 是 ${meta.version}，本地是 ${pkg.version}（未发布？）`)
  } catch (err) {
    note(`npm 查询失败：${err.message}`)
  }
  const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? '')?.[1]
  if (repo) {
    try {
      const rel = await get(`https://api.github.com/repos/${repo}/releases/latest`)
      if (rel.tag_name !== `v${pkg.version}`) note(`GitHub 最新 Release 是 ${rel.tag_name}，本地是 v${pkg.version}`)
      if (!rel.assets?.length) note('最新 Release 没有附件（应与 npm tarball 一致）')
    } catch (err) {
      note(`GitHub 查询失败：${err.message}`)
    }
  }
}

// ---------- 结果 ----------

if (problems.length) {
  console.log(`doc:check 失败（${problems.length} 项）：`)
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
console.log(`doc:check 通过：${mdFiles.length} 个 md / ${linkCount} 条链接 / 版本 ${pkg.version} / 测试 ${testCount} 项${online ? '（含双通道核对）' : ''}`)
