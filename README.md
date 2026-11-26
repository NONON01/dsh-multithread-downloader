# 多线程下载器 · DSH 插件

[![npm](https://img.shields.io/npm/v/dsh-multithread-downloader?style=flat-square)](https://www.npmjs.com/package/dsh-multithread-downloader)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**不用装 aria2，让 DSH Agent 原生下载文件到这台机器。**
分片并发、断点续传、指纹校验、限速与站点自适应都在 Host 里跑，Agent 一个工具调用就能用，面板里看得见进度。

> A multi-threaded (HTTP Range) downloader plugin for [DeepSeek Harness](https://github.com/deepseek-ai). Gives the agent a native `downloader` tool and a live progress panel — no external download manager needed.

![下载器面板](https://cdn.jsdelivr.net/gh/NONON01/dsh-multithread-downloader@main/docs/screenshots/panel-tasks.png)

## 30 秒看懂

| 你会遇到的场景 | 这个插件怎么做 |
|---|---|
| Agent 要下载一个大文件 | `downloader({ action: 'add', url })`，分片并发下到本机，进度在面板与对话条里实时可见 |
| 下载要几分钟，Agent 一直问「好了吗」 | `list` 带 `waitSeconds`，一次等完成，或看 `etaSeconds` 预估剩余时间 |
| 站点 403 / 429 风控 | 自动按站点降并发、加聚合限速、冷却重试；不同站点互不影响 |
| 机器同时在跑别的东西 | 按 CPU / 内存占用自动收缩并发，负载下去再逐步恢复 |
| 小文件也要弹面板 | 小于阈值的任务静默完成，不刷屏 |

## 安装

**npm（推荐）**

```bash
npm i dsh-multithread-downloader
```

或在 DSH 的插件管理里把这个包作为 bundle 安装，重启 / 热重载后生效。面板在侧边栏「多线程下载器」。

- 最低 DSH `>=0.2.1-rc.2`，已在 **0.2.2-rc.5** 验证
- Node `>=22`
- 只支持 HTTP/HTTPS 直链（见[限制](#限制与非目标)）

## 为什么不用浏览器下载 / 外部下载器

| | 浏览器 | aria2 + 脚本 | 本插件 |
|---|---|---|---|
| Agent 能直接调用 | ✗ | 需要自己包一层 | ✓ 原生工具 + 技能 |
| 进度在对话里可见 | ✗ | ✗ | ✓ 面板 / 对话条 / 侧边栏计数 |
| 断点续传 + 版本校验 | 部分 | ✓ | ✓ 指纹旁证 + `If-Range`，远端换版本自动重下 |
| 设备负载 / 站点风控自适应 | ✗ | 需手工配置 | ✓ 默认开启，可按站点独立降档 |
| 安装成本 | 0 | 装二进制 + 写配置 | 一条 `npm i` |

## 功能

**下载能力**

- HTTP Range 分片并发，服务器不支持 Range 时自动回退单连接
- 断点续传：续传前与收尾都用 ETag / Last-Modified 指纹复核，分片请求带 `If-Range`，远端换版本自动从头重下
- 分片指数退避重试（含 `Retry-After`）、请求超时、镜像回退、批量 URL（一次最多 20 个）
- 多算法校验：SHA-256 / SHA-512 / SHA-1 / MD5 / CRC32；下载前检查磁盘空间
- 自定义请求头（Cookie / Referer / Authorization），401/403 直接告诉你缺什么

**可控与自适应**

- 并发限制数：连接数 = 任务数 × 线程数，默认 16（1..64），超出排队，Agent 不能绕过
- 设备负载自适应：每 2 秒采样 CPU / 内存，持续高负载才收缩（避开握手尖峰），空闲时直接回到设定值，压力回落后逐步恢复
- 站点风控自适应：命中 403/429/503 后按注册域降并发 + 聚合限速 + 冷却，各站点独立
- 跟随重定向后复用最终地址（GitHub Release 资产的签名 CDN 直链），分片不再每次都走一遍 302
- 全局限速（KB/s）、自动分片数（按大小 4/6/8）、单线程阈值、静默阈值都可调
- 分片数运行时爬升：不少站点是**单连接限速**（4 条 × 300 KB/s 只能到 1.2 MB/s，而预算里还空着十多条）。每条连接都不快、全局连接有富余时，起步阶段每 1.2 秒（之后每 3 秒）把一段剩余区间切给新连接（每次最多 2 条），自动模式最多 8 条；先跑完的分片交还的连接会立刻被填上，收尾阶段也保持满并发。已下载的字节原地保留，不需要为提速重建任务

**界面**

- 侧边栏面板：任务列表、进度条、速度、**剩余时间**、大文件速度曲线
- 对话输入框上方的实时进度条：多任务分段显示，带百分比、速度与**预估剩余时间**（收起后也保留）
- 一张「设置」卡片收拢全部选项，默认收起，标题栏显示当前并发 / 限速 / 阈值
- Windows 用随包的原生目录选择器（资源管理器同款）；macOS / Linux 回退系统命令或内置浏览器

**给 Agent 的配套工具**

- `doh_lookup`：直接走 DNS over HTTPS 解析 A/AAAA/CNAME/TXT/MX 等记录，本机 DNS 被污染时先拿真实 IP
- `http_probe`：只发 HEAD / 1 字节 Range，返回大小、是否支持 Range、ETag 与 403 原因，不下载正文
- 两个工具都不创建任务、不占连接配额

## Agent 用法

```js
// 新建下载（返回任务 id、路径、剩余字节与 ETA）
downloader({ action: 'add', url: 'https://example.com/big.iso' })

// 要等结果就一次等到底，不要轮询
downloader({ action: 'list', id: 'a1b2c3d4', waitSeconds: 120 })

// 控制
downloader({ action: 'pause', id: 'a1b2c3d4' })
downloader({ action: 'resume', id: 'a1b2c3d4' })
```

任务对象包含 `status`、`progress`、`speed`、`remainingBytes`、`etaSeconds`、`path`、`error`，静默任务也仍可用 `list` 查到。

## 面板与设置

设置全部收在面板底部的「设置」卡片里，展开后分四组：**连接与带宽**、**下载与续传**、**Agent 与阈值**、**网络与站点**。收起时标题栏显示当前并发数、限速、静默阈值与 DoH 状态。

- **并发限制数**：1..64，默认 16；限制的是连接数（并发任务数 × 单任务线程数），Agent 自主模式同样受它约束
- **静默下载阈值**：默认 16 MB，仅约束 Agent 发起的下载；用户手动下载始终显示
- **单线程阈值**：默认 4 MB，小于它的 Agent 任务单连接下载
- **Agent 自主模式**：默认开，Agent 可自行指定 `threads` / `singleThread`
- **DoH 解析** / **GitHub 模式**：默认关，开启前有说明；Agent 也可按任务启用

全部设置持久化到 profile 目录下的 `multithread-downloader.json`，DSH 重启后恢复。

## 配置（`cordis.patch.yml`）

```yaml
threads: 4              # 显式/上限分片数 1..16
autoThreads: true       # 未指定线程数时按大小自动 4/6/8
fingerprintResume: true # 续传前与收尾校验 ETag/Last-Modified
maxConnections: 16      # 并发限制数（连接数），设备负载自适应在此上限内调节
loadAdaptive: true      # 设备负载自适应
siteAdaptive: true      # 站点风控自适应
largeFileMb: 16         # 静默阈值（MB），仅首次默认值
silentEnabled: true
minThreadMb: 4          # 单连接阈值（MB）
minThreadEnabled: true
agentAutonomy: true
rateLimitKb: 102400     # 全局限速 KB/s，0 不限
dohEnabled: false
dohProvider: alidns
githubEnabled: false
```

## 默认下载目录

- **Windows**：读 `HKCU\...\User Shell Folders` 的 Downloads Known Folder（支持重定向到 OneDrive / 其他盘），失败回退 `%USERPROFILE%\Downloads`
- **Linux**：`~/.config/user-dirs.dirs` 的 `XDG_DOWNLOAD_DIR`，回退 `~/Downloads`
- **macOS**：`~/Downloads`
- 显式传入的 `directory` / 面板里选了目录时以它为准；路径含中文、空格都支持

## 开发

```bash
npm test            # node --test，67 项
npm pack --dry-run  # 确认 docs/ 未进包
```

| 路径 | 作用 |
|---|---|
| `index.js` | 插件入口：三个工具、`/api/mtd/*` 路由、任务管理、系统提示与技能 |
| `client.js` | Web GUI 面板、设置卡片、对话进度条、侧边栏图标 |
| `lib/doh.js` | DoH 解析（带 TTL 缓存）与 undici dispatcher |
| `lib/net.js` | URL / 请求头规范化、跟随重定向、HEAD/Range 探测、指纹比较、GitHub 资产解析 |
| `lib/limits.js` | 连接配额、令牌桶限速、负载自适应、站点风控 |
| `lib/files.js` | 目录解析、原生选择器、文件名规范化、同名避让、磁盘空间 |
| `lib/checksum.js` | md5 / sha1 / sha256 / sha512 / crc32 |
| `lib/index.js` | 可复用模块入口（包内 `./lib` 等子路径导入） |

`lib/*` 不依赖 DSH 上下文，其它插件可以直接 `import { doh, net, limits } from 'dsh-multithread-downloader/lib'`。

开发文档见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，完整使用说明见 [docs/GUIDE.md](docs/GUIDE.md)，安全见 [SECURITY.md](SECURITY.md)，发布见 [PUBLISHING.md](PUBLISHING.md)。

## 限制与非目标

只支持 HTTP/HTTPS 直链。以下能力**已明确放弃、不会实现**：FTP / SFTP、BT / 磁力、浏览器接管或自动读取登录态、代理配置、HLS / DASH。

其它限制：

- 需要登录或防盗链的资源，必须显式提供 Cookie / Referer / Authorization
- 自定义请求头会随未完成任务明文保存在 profile 目录，使用敏感 Cookie 时注意本机权限
- 跨域重定向会剥离 `Cookie`、`Authorization`、`Proxy-Authorization`
- 指纹校验依赖源站返回 ETag / Last-Modified；都没有时只能按大小判断
- 未完成任务重启后恢复为暂停状态；已完成文件保留

## 支持这个项目

如果这个插件帮你省下了装下载器、写脚本的时间，**点一个 ⭐ 就是最好的支持** —— 它能让更多在找 DSH 下载方案的人看到这个项目。

发现问题欢迎开 [Issue](https://github.com/NONON01/dsh-multithread-downloader/issues)，附上下载地址（可脱敏）、返回的错误信息和面板截图会更快定位。

## 许可证

MIT，见 [LICENSE](LICENSE)。
