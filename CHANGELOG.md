# Changelog

## 1.4.0（2026-11-25）

- 修复：下载目录含中文时可能乱码 —— Windows 的 `reg.exe` 按系统 OEM 代码页（中文系统 GBK）写管道，之前按 UTF-8 解码；现在先严格 UTF-8、失败回退 GBK，并改为收集 `Buffer` 后整体解码，避免多字节字符被分块截断
- 修复：服务器用 GBK 直接写 `Content-Disposition: filename="中文.zip"` 时文件名乱码；现在同样先 UTF-8 再回退 GBK，`filename*` 仍优先
- 修复：`lib` 拆分后 `Downloader.add()` 漏 import `parseHttpUrl`，导致新建下载直接报 `parseHttpUrl is not defined`；补上并新增端到端用例（中文目录 + 中文文件名真实下载）
- 新增预估剩余时间：任务对象返回 `remainingBytes` 与 `etaSeconds`，面板任务行、统计栏、对话进度条都显示 ETA；仅在正在下载且速度有效时给出，避免误导性的 0/∞
- `downloader({ action: 'list' })` 新增 `waitSeconds`（0..300）：一次调用等到任务结束或超时，返回 `waitedSeconds`；新增 `id` 过滤只查单个任务；工具描述、系统提示与 skill 均改为「不要反复轮询 list」
- 补齐工具输出 schema：`remainingBytes`、`etaSeconds`、`siteKey`、`siteThrottle`、`riskRetries`、`riskNote` 之前缺失，站点被限速时会触发 invalid output
- `package.json` 补 `main: ./lib/index.js`，`./lib` 额外导出 `apply` / `inject` 与文件/DoH 工具函数；`exports["./client"]` 已在 1.4.0 提供
- README 重写为产品向首页（一句话定位、30 秒场景、浏览器/aria2 对比表、安装与 Agent 用法、Star 引导）；PUBLISHING 补 GitHub About 文案与 Topics 清单
- 新增 `doh_lookup` 工具：任何会话都能走 DoH 解析，支持 A/AAAA/CNAME/TXT/MX/NS/SOA/PTR/SRV/CAA/HTTPS、批量域名、自定义提供商与跳过缓存；传 IP 时原样返回。本机 DNS 被污染时可先取真实 IP 再直连
- 新增 `http_probe` 工具：只发 HEAD 或 1 字节 Range，返回大小、Range 支持、文件名、ETag/Last-Modified，401/403 时说明所需请求头；可选 `doh: true` 走 DoH 解析
- 内部能力拆成可复用模块 `lib/doh.js` / `lib/net.js` / `lib/limits.js` / `lib/files.js` / `lib/checksum.js`，不依赖 DSH 上下文；包内开放 `./lib`、`./doh`、`./net`、`./limits`、`./files`、`./checksum` 子路径导入
- `createDohResolver()` 支持自定义 DoH 端点（`endpoint`）与可配置超时/缓存 TTL，并额外返回 CNAME/TXT 等记录
- 面板所有设置收进一张「设置」折叠卡片（默认收起），标题栏显示并发 / 限速 / 静默阈值 / DoH 状态的摘要；展开后按「连接与带宽」「下载与续传」「Agent 与阈值」「网络与站点」四组排列，每项说明独占一行
- 测试补齐到 57 项：lib 模块独立导入、DoH 解析与缓存、`doh_lookup` 参数校验与 IP 短路、`http_probe` 不读正文、旧 `maxConcurrent` 键不会被当成连接上限、OEM/GBK 输出与响应头文件名解码、中文目录端到端下载、ETA 计算；另加回归项——416 不再空转、正文空闲超时、暂停后立刻恢复只有一轮、重启恢复、`clean` 释放文件名、队列中任务可暂停、多租户站点不被误并
- 修复（全量审查）：Range 请求收到 **416** 时不再当作「本段已完成」——之前游标不前进、退避计数归零，会以每秒数十次的速率持续打远端且永不结束；现在抛 `RANGE_UNSATISFIABLE`，整轮只重建一次分片，再失败就带原因失败
- 修复：`lib` 拆分后 `restoreTasks()` 漏 import `existsSync`，导致请求被逐条静默吞掉、**重启后一个任务都恢复不出来**（磁盘上会留下孤立的 `.mtd-part`）
- 修复：`/pick-directory` 里 `electronDialog()` / `NATIVE_PICKER` 未定义，Windows 点「选择…」必然抛错并伪装成「用户取消」；现在原生选择器真正可用，失败也会如实返回 `ok: false`
- 修复：下载中 `pause` 后立刻 `resume` 会留下两轮并发的分片循环——旧轮收尾可能对新轮 `finalize()`/`fail()`，成功后还残留 `file closed` 错误；现在每轮持有 `runToken`，旧轮发现令牌变化就退出
- 修复：分片正文没有空闲超时，服务端回了 206 头和几个字节就停住时任务会永远卡在 `downloading`、速度 0、并一直占着全局连接槽；现在 30 秒无新字节即中断重试（`ioIdleTimeoutMs` 可覆盖）
- 修复：`Retry-After` 之前是死代码（`retryDelay` 的调用点从不传响应）；现在 HTTP 错误会带上 `retryAfterMs`，分片重试与探测重试都会遵循服务端节奏
- 修复：恢复任务时补回 `origin` / `forceDisplay` / `doh` / `dohProvider` / `github`，并写入任务记录；否则用户任务恢复后会被当成静默任务从面板消失
- 修复：`clean()` 未释放文件名占位，失败任务清掉后同名下载会莫名变成 `xxx (1).bin`
- 修复：`dispose()` 未关闭 DoH 的 undici Agent，插件重载会留下 keep-alive 连接
- 修复：排队中（`queued`）的任务 `pause` 之前是静默无效但返回成功；现在会真正停下，`resume` 对 `canceled` / `completed` 返回明确错误
- 工具：`forceDisplay` / `doh` / `dohProvider` / `github` 之前不在参数 schema 里（Agent 无法发现），现在补齐；`list` 新增 `timedOut`，`waitSeconds` 会响应工具取消信号，查不存在的 id 返回明确错误，并删掉描述里实际从不返回的 `history` 承诺
- 修复：URL 里含非法百分号编码（如 `%zz`）时 `filenameFromUrl` 抛 `URIError` 导致整个任务失败，现在回退到未解码的文件名
- 修复：面板原生目录选择器的按钮类名与头部目录行同名，样式互相污染；线程默认值现在跟随 Host 配置而不是硬编码 4
- 站点归并：`github.io` / `s3.amazonaws.com` / `aliyuncs.com` 等多租户后缀不再按最后两段合并，避免一个租户被风控降档时误伤同后缀的其它站点
- 文档：GUIDE 版本号与测试覆盖、DEVELOPMENT 的分片字段/状态机/路由/slot 映射、SECURITY 的跨域 Cookie 描述、MARKETPLACE 的能力描述全部与代码对齐（负载恢复实测约 28 秒，文案不再写「十几秒」）
- 启动时若设置文件仍是旧 schema（如 v10 带 `maxConcurrent: 3`），读取后立即重写为当前 schema，并发上限回到默认 16，面板不再显示旧的 3
- 设备负载自适应（默认开）：每 2 秒采样系统 CPU/内存，压力 ≥55/70/85/95% 时把连接预算压到 80/60/35/20%，**立即收缩**、回落后每两周期抬一档逐步恢复；面板显示 CPU、内存、档位与实际生效连接数
- 站点风控自适应（默认开）：同一网站（按注册域归并，含子域与不同页面，GitHub 各域统一算 github.com）命中 403/429/503 后按站点降档——并发 4→2→1、站点聚合限速 2M→768K→256K→128K、冷却 3→8→20→60 秒；同一波并发失败只降一档，冷却在槽位外等待，进度不丢，连续成功逐档恢复
- 站点之间策略独立：被风控站点的冷却不占全局连接，不影响其它站点；单任务降档重试上限 3 次，超出后失败并说明
- 面板新增「站点限速」列表（站点、档位、并发、限速、剩余冷却）与任务级 `siteThrottle` / `riskRetries` / `riskNote`；`/state` 新增 `resources`、`sites`、`effectiveConnections`
- 设置文件升到 version 12（`loadAdaptive`、`siteAdaptive`）
- 面板设置「同时下载任务数」改为「并发限制数」：限制的是连接数（并发上限 = 并发任务数 × 单任务线程数），默认 16，范围 1..64
- 新增全局连接预算 `ConnectionSlots`：所有任务（含 Agent 自主模式、显式 `threads`）共享同一上限，超出排队；Agent 无法绕过
- 任务活跃数上限随连接预算推导，单个任务的分片数也不会超过预算
- 每个连接按 4 MB 分段轮转：多任务共享预算时轮流占用，不会让先来的任务独占全部连接
- 面板统计新增「连接 x/y」，取 0 时也可从 `state.activeConnections` 读取
- 设置文件升到 version 11（`maxConnections`），旧 `maxConcurrent` 字段忽略并回落默认 16

## 1.3.0

- 续传指纹校验：`.mtd-meta` 旁证（地址/大小/ETag/Last-Modified）+ 续传前复核 + 完成前复核；不一致从头重下或拒绝交付
- 分片请求带 `If-Range`（强 ETag 优先，否则 Last-Modified）；下载途中远端换版本自动整段重下，不会拼出混合文件
- 探测失败时不再静默续传：有校验值且开启指纹校验则明确失败
- 新增「续传指纹校验」开关（默认开）；任务详情返回 `fingerprint.state/note`
- 自动分片数：未显式指定 `threads` 时按大小选 4/6/8 条连接，新增「自动分片数」开关（默认开）
- 多算法校验：SHA-256 / SHA-512 / SHA-1 / MD5 / CRC32；`checksum: { algorithm, value }`，保留 `sha256` 旧参数
- 面板高级选项增加校验算法选择
- 测试补齐到 20 项：指纹变化、If-Range 重开、续传复核、探测失败拒绝续传、阶梯线程

## 1.2.0

- 新增多算法校验：SHA-256 / SHA-512 / SHA-1 / MD5 / CRC32
- 新增 `checksum: { algorithm, value }` 参数；保留 `sha256` 旧参数
- 面板高级选项增加校验算法选择
- 与 1.3.0 一起发布

## 1.1.2

- 大文件曲线改为速度曲线：等距速度刻度、按整数 MB/KB 步长取整、移除时间轴、增强网格可见性
- 修复曲线末端圆点按进度而非速度定位的问题
- 新增 `forceDisplay`：Agent 可按任务覆盖静默阈值；强制显示的任务也会显示速度曲线

## 1.1.1

- 修正 `engines.node` 为 `>=22`：undici 8 在 Node 20 上无法加载
- CI 矩阵改为 Node 22 / 24，全部通过

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
- 全局限速、并发限制数、单线程阈值、静默下载阈值
- Agent 工具与技能，用户手动下载始终显示并多线程
- 侧边栏面板、对话进度条、Windows 原生目录选择器（macOS/Linux 回退）
