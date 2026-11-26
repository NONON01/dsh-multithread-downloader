# 发布清单

## 已就绪

- 1.0.1：CI 全绿，发布目标 registry.npmjs.org

- 包名 `dsh-multithread-downloader`（npm 公共 registry 当前可用）
- LICENSE (MIT)、CHANGELOG、SECURITY、PUBLISHING
- `engines.dsh >=0.2.1-rc.2`，`peerDependencies.@deepseek-ai/dsh`
- 单元/集成测试 67 项通过；CI 覆盖 Linux/Windows/macOS × Node 22/24
- `npm pack` 产物已验证可解包、入口可解析
- 明确非目标：FTP/SFTP、BT、浏览器接管、代理、HLS/DASH
- 原生助手构建脚本 `bin/build.ps1`
  - `bin/picker.exe` SHA-256：`8b4a4f2c6683fbedd26647d8a1ed306ea9c3daaaa24fd6798ee9089368dd330f`

## npm

已发布 `dsh-multithread-downloader@1.1.0` 到 registry.npmjs.org（2026-11-08）：DoH 解析与 GitHub 模式。

已发布 `dsh-multithread-downloader@1.3.0`（2026-11-23），同时发布 GitHub Release `v1.3.0`：
续传指纹校验（旁证 + ETag/Last-Modified 复核 + `If-Range`）、自动分片数 4/6/8、多算法校验
（SHA-256 / SHA-512 / SHA-1 / MD5 / CRC32）、`forceDisplay` 速度曲线。

- npm：`npm view dsh-multithread-downloader dist-tags` → `latest: 1.3.0`
- Release 附件：`dsh-multithread-downloader-1.3.0.tgz`（与 npm tarball 同一份）

## GitHub 仓库设置（About / Topics）

这些是仓库页面上的字段，改一次就长期生效，也是 GitHub 站内搜索的入口。**需要用户确认后再改**。

About（英文，一行，控制在 120 字符内）：

```
Native HTTP/HTTPS multi-thread downloader for DeepSeek Harness: agent tool + live panel, resume, checksum, adaptive limits.
```

Topics（点齿轮逐个添加，或走 API）：

```
dsh-plugin, dsh, deepseek-harness, downloader, multithread-downloader,
http-downloader, resumable-download, agent-tool, typescript, nodejs
```

用 API 一次性写入（需要带 `repo` 权限的 token，执行前先确认）：

```bash
curl -X PUT https://api.github.com/repos/NONON01/dsh-multithread-downloader/topics \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"names":["dsh-plugin","dsh","deepseek-harness","downloader","multithread-downloader","http-downloader","resumable-download","agent-tool"]}'

curl -X PATCH https://api.github.com/repos/NONON01/dsh-multithread-downloader \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"description":"Native HTTP/HTTPS multi-thread downloader for DeepSeek Harness: agent tool + live panel, resume, checksum, adaptive limits.","homepage":"https://www.npmjs.com/package/dsh-multithread-downloader"}'
```

## 发布前仍需人工完成

1. ~~仓库地址~~ 已补 `NONON01/dsh-multithread-downloader`
2. ~~作者~~ 已填 `NONON01`
3. ~~市场分类/权限说明~~ 见 `MARKETPLACE.md`；截图待补
4. ~~目标 registry~~ 已固定 `registry.npmjs.org`
5. ~~npm 打包校验~~ `npm publish --dry-run` 通过
6. **npm 登录/令牌**：发布前必须 `npm login --registry=https://registry.npmjs.org` 或提供 `NODE_AUTH_TOKEN`
7. Windows 助手签名证书（可选，未签名会触发 SmartScreen）
8. 在干净 profile 中安装 `npm pack` 产物并验证升级
9. 市场截图

## 打包检查

```bash
npm test
npm pack --dry-run
```

## 当前本地验证

- 已以 `dsh-multithread-downloader` 重新 link 安装，工具与 `/api/mtd/state` 正常
- 旧 `@local/multithread-downloader` 依赖已从 profile 移除
