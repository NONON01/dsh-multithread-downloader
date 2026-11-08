# Changelog

## 1.1.0

- 新增 DoH 解析模式：Cloudflare / AliDNS / Tencent 三选一，开启前弹风险确认；Agent 可用 `doh` / `dohProvider` 按任务启用，失败回退系统 DNS
- 新增 GitHub 模式：面板开关 + Agent 按任务 `github: true`，把 Release 直链换成 API 资产链接，绕过 github.com DNS 污染
- 依赖 `undici` 以支持自定义 DNS dispatcher；最低 Node 提升到 22（undici 8 在 Node 20 上不兼容）
- 实测：GitHub 直链在 DoH（AliDNS/Tencent）下可下载；GitHub 模式无需 DoH 也可下载

## 1.0.4

- 默认全局限速改为 100 MB/s（`rateLimitKb: 102400`），仍可在面板调整或设为 0 关闭
- 实测：AMD 623 MB 驱动在 4 线程 + 100 MB/s 上限下完成，平均约 43 MB/s，说明上限高于 CDN 实际带宽
- 本地 128 MB 文件约 62 MB/s（受宿主/磁盘限制，未触顶）

## 1.0.3

- 在 DSH `0.2.2-rc.1` 上完成兼容性验证：Agent 自主模式下带请求头 + SHA-256 的 2 MB 分片下载正常
- 无功能变更，仅标记 0.2.2 兼容

## 1.0.2

- 标记 DSH `0.2.1-rc.5` 兼容性：官方 rc.3 → rc.5 未改动插件使用的 slots / tools / webServer / locale 接口
- 无功能变更，升级可选

## 兼容性

- 已核对 DSH `0.2.1-rc.5`：官方 rc.3 → rc.5 仅调整思考内容展示与版本号，插件使用的 slots / tools / webServer / locale 接口未变，1.0.1 可直接运行。

## 1.0.1

- 修复 Windows + Node 20 下 `npm test` 的 shell 通配符问题，CI 全绿
- 明确 npm 发布目标为 registry.npmjs.org

## 1.0.0

首个发布版本。

- HTTP/HTTPS Range 分片并发下载，最多 16 连接/任务，服务器不支持 Range 时回退单连接
- 断点续传：暂停/恢复、ETag/Last-Modified 校验、未完成任务跨重启恢复
- 自定义请求头（Cookie / Referer / Authorization），401/403 提示
- 分片重试（指数退避）、请求超时、镜像回退
- 批量 URL、SHA-256 校验、下载前磁盘空间检查
- 全局限速、同时下载任务数、单线程阈值、静默下载阈值
- Agent 工具与技能，用户手动下载始终显示并多线程
- 侧边栏面板、对话进度条、Windows 原生目录选择器（macOS/Linux 回退）
