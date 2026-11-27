# 多线程下载器（DSH 插件）完整说明

> 版本：1.4.2  
> 仓库：https://github.com/NONON01/dsh-multithread-downloader  
> npm：https://www.npmjs.com/package/dsh-multithread-downloader  
> 最低 DSH：`>=0.2.1-rc.2`；最低 Node：`>=22`

---

## 目录

1. [简介](#简介)
2. [功能总览](#功能总览)
3. [安装与升级](#安装与升级)
4. [界面说明](#界面说明)
5. [用户手动下载](#用户手动下载)
6. [Agent 下载与自主模式](#agent-下载与自主模式)
7. [阈值与显示规则](#阈值与显示规则)
8. [设置项](#设置项)
9. [负载与站点自适应](#负载与站点自适应)
10. [DoH 解析模式](#doh-解析模式)
11. [GitHub 模式](#github-模式)
12. [请求头、校验、镜像与批量](#请求头校验镜像与批量)
13. [断点续传与任务持久化](#断点续传与任务持久化)
14. [Agent 工具 API](#agent-工具-api)
15. [配套工具：doh_lookup 与 http_probe](#配套工具doh_lookup-与-http_probe)
16. [作为模块复用](#作为模块复用)
17. [本地 HTTP API](#本地-http-api)
18. [文件与路径](#文件与路径)
19. [安全说明](#安全说明)
20. [限制与非目标](#限制与非目标)
21. [故障排查](#故障排查)
22. [开发与测试](#开发与测试)
23. [版本与发布](#版本与发布)

---

## 简介

这是一个运行在 DeepSeek Harness（DSH）里的 HTTP/HTTPS 文件下载器。

它同时提供三种使用方式：

- **Web GUI 面板**：新建下载、查看任务、暂停/续传/取消
- **对话输入框上方的进度条**：显示进行中的下载
- **Agent 工具 `downloader`**：模型可以直接创建和管理下载任务

下载由 DSH Host 执行，文件写入 Host 所在机器，不需要浏览器保持页面打开。

![面板](screenshots/panel.png)

---

## 功能总览

- HTTP/HTTPS Range 分片并发下载，单任务最多 16 连接
- 断点续传：暂停/恢复、指纹旁证 + If-Range 校验、Range 被忽略时自动回退单连接
- 自动分片数：未显式指定时按大小选 4/6/8 条连接，运行中可爬到最多 8 条，收尾也保持满并发
- 未完成任务持久化，插件重载/DSH 重启后恢复为暂停状态
- 自定义请求头：Cookie / Referer / Authorization 等
- 401/403 给出明确提示
- 分片重试：指数退避，响应头超时 30 秒
- 停滞看门狗：连接半死但还在涓流时按窗口吞吐判定，换一组连接（最多 2 次），之后标记「远端极慢」继续下
- 镜像回退、批量 URL
- 可选多算法校验（SHA-256 / SHA-512 / SHA-1 / MD5 / CRC32）、下载前磁盘空间检查
- 全局限速（默认 100 MB/s）与并发限制数（默认 16 条连接，= 任务数 × 线程数；超出排队，Agent 自主模式同样受约束）
- 设备负载自适应：每 2 秒采样 CPU/内存，持续高负载才收缩，空闲时回到设定值，回落逐步恢复
- 站点风控自适应：403/429/503 后按站点降并发 + 聚合限速 + 冷却重试，站点之间互不影响
- 可选 DoH 解析（Cloudflare / AliDNS / Tencent）
- GitHub Release 直链自动转 API 资产链接
- `forceDisplay` 强制显示低于静默阈值的任务，并显示速度曲线
- 面板、侧边栏未完成计数、对话进度条、速度曲线
- Windows Known Folder 默认目录、系统原生目录选择器

---

## 安装与升级

### 从 npm 安装

```bash
npm i dsh-multithread-downloader
```

或在 DSH 插件管理里安装 bundle：

```text
dsh-multithread-downloader
```

### 本地开发安装

在 DSH 插件管理里选择本地目录 / `link:` 安装：

```text
link:F:\DSH_Work\multithread-downloader
```

### 升级

- npm 安装：重新安装新版本，或在插件管理里执行更新
- 本地 link：直接更新目录内容后重载插件
- 设置和任务记录保存在 profile 目录，升级不会丢失

安装/重载后，如果页面仍显示旧界面，刷新一次浏览器页面。

---

## 界面说明

### 侧边栏面板

- 新建下载：URL、保存目录、线程数、开始下载
- 高级选项：请求头、校验算法与校验值、批量 URL
- **设置**：面板底部一张可折叠卡片，默认收起；标题栏显示当前关键值（并发、限速、静默阈值、DoH 状态），点标题展开。展开后按四组排列：
  - **连接与带宽**：并发限制数、全局限速、设备负载自适应
  - **下载与续传**：自动分片数、续传指纹校验
  - **Agent 与阈值**：Agent 自主模式、静默下载阈值、单线程阈值
  - **网络与站点**：站点风控自适应、DoH 解析与提供商、GitHub 模式
- 任务列表：状态、进度、速度、**剩余时间（ETA）**、大小、操作按钮
- 统计栏显示进行中/已完成/总速度/预计剩余/任务数/连接数 x/y
- 大文件任务显示速度曲线

### 对话进度条

位于输入框上方，显示：

- 文件名
- 已下载 / 总大小
- 百分比
- 当前速度
- 预计剩余时间（速度有效时；收起后的窄条也保留）
- 分段进度条（多任务时按任务大小切段）
- 收起/恢复按钮

### 侧边栏计数

图标角标显示未完成任务数（排队/解析/下载/暂停）。

---

## 用户手动下载

在面板里手动填 URL、目录、线程数并提交，视为**用户手动下载**：

- 始终显示在面板和对话进度条
- 始终按所选线程数分片（选 1 线程则单连接）
- 不受静默阈值、单线程阈值影响
- 不受 Agent 自主模式影响

---

## Agent 下载与自主模式

Agent 通过 `downloader` 工具创建的任务视为 **Agent 下载**：

- 默认受静默阈值和单线程阈值约束
- Agent 自主模式开启时，Agent 可以用 `threads` / `singleThread` 指定自己的策略
- 可用 `forceDisplay: true` 强制显示低于静默阈值的任务
- 可用 `doh: true` / `github: true` 为单个任务启用对应模式

### Agent 自主模式

- 默认开启
- 开启后面板上的静默阈值、单线程阈值设置会被置灰，但数值仍继续约束 Agent 任务
- 用户手动下载不受影响
- 可随时在面板关闭

---

## 阈值与显示规则

### 静默阈值

- 默认开启，16 MB，单位 KB/MB/GB
- 仅约束 Agent 任务
- 小于阈值：任务照常下载，但不进入面板、对话条、侧边栏计数
- 大于等于阈值：显示任务并记录速度采样
- `forceDisplay: true` 可覆盖此规则
- 关闭开关后显示所有任务

### 单线程阈值

- 默认开启，4 MB，单位 KB/MB
- 仅约束 Agent 任务
- 小于阈值：单连接下载（仍使用 Range，支持续传）
- 关闭开关后 Agent 任务也不做尺寸降级
- `singleThread` 显式参数优先

### 自动分片数

- 默认开启；仅在调用方没给 `threads` 时生效
- < 32 MB：4 条；< 256 MB：6 条；更大：8 条
- 还要受最小分片 512 KB 和 `singleThread` 阈值约束
- 显式 `threads` 永远优先；关闭后统一用配置/面板线程数

### 分片数爬升（运行中自动提速）

起步分片数不是终局。很多站点限制的是**单条连接**（比如每条 300 KB/s），4 条连接只能跑 1.2 MB/s，而全局连接预算里还空着十几条——早先分片数在探测后固定，低并发起步的任务就再也追不回来。

现在任务运行中复核（起步阶段每 1.2 秒一次，之后每 3 秒一次），**同时**满足下列条件就把一个分片的剩余区间对半切开，多起一条连接：

- 服务器支持 Range，且当前不是单连接模式
- 平均每条连接速度 < 640 KB/s（说明瓶颈在单连接限速，而不是总带宽吃满）；没有任何速度采样时不扩容
- 该站点没有被风控降档（降档时瓶颈是站点配额，加连接只会更快撞墙）
- 全局连接预算还有空闲（不去抢别的任务的连接）
- 当前连接数没到上限；每次复核最多加 2 条，避免一次把站点打醒
- 要切的那段剩余区间还够分成两个 256 KB 以上的分片

进度过半、剩余不多时**不再停止爬升**：先跑完的分片会把连接交还回来，那一刻立刻把还长的剩余区间切一段给空闲连接，所以收尾阶段也能满并发跑完最后几 MB。并发上限管的是**同时在用的连接数**，分片条数可以超过它。

上限：自动模式下最多 8 条；调用方显式给了 `threads` 时**不爬升**（保持指定值）。切分按字节偏移进行，已下载的部分原样保留，**不需要取消重建任务**——重建只会把已下的字节重下一遍。

面板里的「n 线程」是当前还在跑的连接数，爬升后跟着变大；任务结束后显示这次真正用过的并发峰值，而不是分片条数。

### 停滞看门狗（默认开）

正文空闲超时只管「一个字节都不来」。连接半死却还在涓流时（实测 4 B/s：速度 10 B/s、ETA 两天、状态一直是「下载中」）它永远不会触发，任务就那么挂着。

看门狗改成看**窗口吞吐**：

- 每 60 秒一个窗口（`stallWindowSec`，可设 10..600），窗口内收到的字节低于下限就判定停滞
- 下限默认 64 KB；**你自己设的全局限速、以及站点风控后的聚合限速会先把下限压下来**（按预期吞吐的一半），否则限速一开每个任务都会被误判
- 没有在途连接（在排队等连接槽或站点冷却）不算停滞；剩余量不足一个下限也不必干预
- 判定停滞：换一组新连接从当前游标续上。**不消耗重试预算、不退避**，多地址时顺便换一个镜像
- 最多换 2 次（`STALL_MAX_RESETS`）；两次之后仍是涓流，标记「远端极慢」并**继续下载**，不判失败
- 速度低于 1 KB/s 时不再报 ETA——那时算出来是「约剩两天」，报出来只会误导

面板上会显示判定原因（`stallNote`），任务对象里也会带上 `stallNote` 与 `slow`。关掉这个开关就回到旧行为：只剩 30 秒正文空闲超时。

### 曲线显示条件

满足任一条件时显示速度曲线：

- 任务总大小 ≥ 静默阈值
- 任务设置了 `forceDisplay: true`

---

## 设置项

所有设置都在面板底部的「设置」卡片里，按四组分类；卡片收起时右侧显示 `并发 n · 限速 · 静默阈值 · DoH 状态` 摘要。

| 分组 | 设置 | 默认 | 范围 / 说明 |
|---|---|---|---|
| 连接与带宽 | 并发限制数 | 16 | 1–64；连接数 = 任务数 × 线程数，超出排队，Agent 不能绕过 |
| 连接与带宽 | 全局限速 | 100 MB/s | 0 表示不限 |
| 连接与带宽 | 设备负载自适应 | 开启 | 持续高负载收缩连接预算，空闲回满，回落逐步恢复 |
| 下载与续传 | 自动分片数 | 开启 | 按大小 4/6/8，运行中最多 8 条连接（收尾也保持满并发）；显式 threads 优先且不爬升 |
| 下载与续传 | 续传指纹校验 | 开启 | 续传/收尾核对 ETag、Last-Modified、If-Range |
| 下载与续传 | 停滞看门狗 | 开启 | 窗口内吞吐过低就换一组连接（最多 2 次），之后标记「远端极慢」继续下；关掉只剩 30 秒空闲超时 |
| Agent 与阈值 | Agent 自主模式 | 开启 | 阈值设置置灰但继续生效 |
| Agent 与阈值 | 静默下载阈值 | 16 MB | 1 KB–10 GB；可开关 |
| Agent 与阈值 | 单线程阈值 | 4 MB | 0–10 GB；可开关 |
| 网络与站点 | 站点风控自适应 | 开启 | 403/429/503 后按站点降档、限速、冷却 |
| 网络与站点 | DoH 解析 | 关闭 | Cloudflare / AliDNS / Tencent；开启前弹风险确认 |
| 网络与站点 | GitHub 模式 | 关闭 | GitHub Release 直链转 API 资产 |

设置保存在 profile 目录的：

```text
multithread-downloader.json
```

当前配置版本：13。

---

## 负载与站点自适应

两项策略都在用户设置里，Agent 工具没有开关，也不能绕过。

### 设备负载自适应（默认开）

每 2 秒采样一次系统 CPU 与内存，压力 = max(CPU 使用率, 内存压力)。

内存压力单独折算：Windows 的 `freemem()` 把系统缓存算成已用，空闲机器也常年 90%+，直接拿占用率当压力会把预算永久压到最低。因此**空闲物理内存还有 1.5 GiB 时一律忽略**，否则使用率要到 88% 才开始计入（88→100 线性放大到 0→100）。

| 压力 | 档位 | 实际连接预算 |
|---|---|---|
| < 55% | 正常 | 设定值 |
| 55–70% | 偏高 | 80% |
| 70–85% | 高 | 60% |
| 85–95% | 高 | 35% |
| ≥ 95% | 紧张 | 20%（至少 1） |

- **持续才收缩**：连续两个采样（约 4 秒）都高于阈值才下调；单次尖峰只记账不动作。下载刚起第一波连接时 TLS 握手会让 CPU 冲一下，这一次尖峰以前足以把预算打到最低。
- **空闲直接回满**：没有任何连接在跑时预算回到设定值，下一个任务不会带着被压低的预算起步。
- **恢复逐步进行**：压力回落到 55% 以下并连续两个采样周期后，每两周期抬一档（约设定值的 1/4），4 个采样左右回到满速。
- 预算同时决定活跃任务数上限，所以高负载时排队任务会自然变少。
- 面板统计里的「连接 used/effective」显示实际生效值；「负载」一段显示 CPU、内存与档位。
- 关闭后始终按设定值分配连接。

### 站点风控自适应（默认开）

站点按**注册域**归并：`cdn.example.com`、`www.example.com`、`example.com/a`、`example.com/b` 属于同一个站点；`a.example.com.cn`、`bbc.co.uk` 这类两级后缀按三段处理；GitHub 的 `api.github.com` / `objects.githubusercontent.com` 统一算 `github.com`。这样同站不同页面不会各自计数、轮番撞风控。

命中 403 / 429 / 503 时：

| 档位 | 站点并发 | 站点聚合限速 | 冷却 |
|---|---|---|---|
| L1 | 4 | 2 MB/s | 3 s |
| L2 | 2 | 768 KB/s | 8 s |
| L3 | 1 | 256 KB/s | 20 s |
| L4 | 1 | 128 KB/s | 60 s |

- 同一波并发分片同时拿到 403 只算一次降档（2 秒去重窗口），不会一次降到最低档。
- 冷却在**槽位之外**等待：被风控站点的等待不占全局连接，其它站点照常下载。
- 下载进度不丢：降档后按各分片断点继续，不重新下载已收到的字节。
- 连续成功若干段后逐档回落到正常（每档需 24 × 档位 段）。
- 单任务最多降档重试 3 次；仍被拒绝则失败并说明「站点已限速重试 N 次」。
- 不同站点各自独立；面板「站点限速」列出当前被限速的站点、档位、并发、限速与剩余冷却。

---
## DoH 解析模式

DoH（DNS over HTTPS）把 DNS 查询封装在 HTTPS 中，用于绕过被污染的本地 DNS。

### 使用方式

- 面板开关「DoH 解析」，开启前会弹出风险确认
- 选择提供商：
  - Cloudflare：`https://cloudflare-dns.com/dns-query`
  - AliDNS：`https://dns.alidns.com/resolve`
  - Tencent：`https://doh.pub/dns-query`
- Agent 可按任务启用：

```json
{ "doh": true, "dohProvider": "alidns" }
```

### 行为

- 只影响下载器的 DNS 解析
- 不改系统 DNS、不改 hosts
- TLS 仍按原域名校验，SNI 不变
- DoH 查询失败时回退系统 DNS
- 默认关闭

### 风险

- DNS 查询会发送给所选第三方
- 提供商可能返回错误结果
- 某些网络中 Cloudflare DoH 不可达，可改用 AliDNS / Tencent

---

## GitHub 模式

用于绕过 `github.com` 被 DNS 污染的情况。

### 使用方式

- 面板开关「GitHub 模式」，默认关闭
- Agent 可按任务启用或覆盖：

```json
{ "github": true }
```

### 行为

识别：

```text
https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
```

自动：

1. 调用 `api.github.com` 查询 release asset
2. 改用 `https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`
3. 附加 `accept: application/octet-stream`

非 GitHub Release 链接不受影响。

### 注意

- 使用 GitHub API 未认证额度（约 60 次/小时）
- 私有仓库暂不支持
- 只处理 Release 下载直链，不处理源码页面/压缩包页面

---

## 请求头、校验、镜像与批量

### 请求头

- 工具参数：`headers` 对象
- 面板：高级选项里按 `Key: value` 每行填写
- 禁止覆盖 `range`、`host`、`content-length`、`connection`、`accept-encoding`
- 401/403/407 会提示需要提供 Cookie / Referer / Authorization
- 请求头会随未完成任务以**明文**保存在 profile 目录

### 校验

- 工具参数：`checksum: { algorithm, value }`，算法支持 `md5` / `sha1` / `sha256` / `sha512` / `crc32`；旧参数 `sha256` 仍兼容
- 完成后流式计算校验
- 不匹配则任务失败，保留 `.mtd-part`

### 镜像

- 工具参数：`mirrors` 数组
- 主地址失败或分片出错时轮换重试

### 批量

- 工具参数：`urls` 数组，最多 20 个
- 面板：高级选项里每行一个 URL
- 批量时忽略 `filename`，由响应头/URL 推断

### 重试与超时

- 每分片最多 4 次尝试
- 指数退避，最长 8 秒
- 遵循 `Retry-After`
- 响应头超时 30 秒，正文空闲超时 30 秒
- 停滞看门狗换连接是健康检查，不消耗上面这 4 次预算，也不退避
- 可重试状态：408 / 425 / 429 / 500 / 502 / 503 / 504
- 不重试：401/403 等客户端错误、非标准 5xx（如 567）

---

## 断点续传与任务持久化

### 暂停/恢复

- 暂停保留 `.mtd-part` 分片文件
- 恢复前依次核对：`.mtd-meta` 旁证（地址/大小/ETag/Last-Modified）→ 远端重新探测
- 任一不一致：丢弃旧分片，按新版本从头下载
- 每个分片请求带 `If-Range`（强 ETag 优先，否则 Last-Modified）；服务器回 200 说明文件已换版本，自动整段重下
- 完成前再核对一次指纹；不一致直接判失败，不交付拼接文件
- 服务器忽略 Range 时自动降级为单连接重下
- 探测失败且本地有校验值时，拒绝在“无法校验”状态下续传（可关掉“续传指纹校验”恢复旧行为）

### 重启恢复

未完成任务写入：

```text
multithread-downloader-tasks.json
```

插件重载/DSH 重启后恢复为 **paused** 状态，分片游标保留，可手动/工具恢复。

完成、取消、失败的任务不会恢复。

---

## Agent 工具 API

工具名：`downloader`

### 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | string | `add` / `list` / `pause` / `resume` / `cancel` / `remove` / `clean` |
| `url` | string | 单个下载地址 |
| `urls` | string[] | 批量地址，最多 20 |
| `mirrors` | string[] | 备用镜像 |
| `directory` | string | 保存目录，省略用默认目录 |
| `filename` | string | 保存文件名 |
| `threads` | int | 1–16 |
| `singleThread` | bool | 强制单连接/分片 |
| `headers` | object | 自定义请求头 |
| `checksum` | object | `{ algorithm, value }`；algorithm 支持 md5/sha1/sha256/sha512/crc32 |
| `sha256` | string | 兼容旧参数，等价于 `checksum.algorithm=sha256` |
| `doh` | bool | 该任务启用 DoH |
| `dohProvider` | string | `cloudflare` / `alidns` / `tencent` |
| `github` | bool | 该任务启用 GitHub 模式 |
| `forceDisplay` | bool | 覆盖静默阈值强制显示 |
| `id` | string | 控制任务时的任务 ID；`list` 时只返回该任务 |
| `limit` | int | `list` 返回条数，1–100，默认 20 |
| `waitSeconds` | int | `list` 时最多等多少秒（0–300，默认 0）：任务结束或超时后返回一次，替代反复轮询 |

### 示例

```json
{
  "action": "add",
  "url": "https://example.com/file.zip",
  "directory": "D:\\Downloads",
  "threads": 8,
  "headers": { "Referer": "https://example.com/" },
  "sha256": "…"
}
```

```json
{ "action": "add", "url": "https://github.com/owner/repo/releases/download/v1/file.exe", "github": true }
```

```json
{ "action": "add", "url": "https://example.com/small.bin", "forceDisplay": true }
```

```json
{ "action": "pause", "id": "a1b2c3d4" }
```

```json
{ "action": "list", "limit": 10 }
```

```json
{ "action": "list", "id": "a1b2c3d4", "waitSeconds": 120 }
```

`waitSeconds` 适合「要等下载完成再继续」的场景：调用会阻塞到任务结束或超时，返回时 `waitedSeconds` 告诉你实际等了多久。不要用连续 `list` 轮询代替它。

### 任务状态

`queued` / `probing` / `downloading` / `paused` / `completed` / `failed` / `canceled`

### 返回值

- 单个任务：`{ ok, action, task }`
- 批量：`{ ok, action, tasks }`
- `list` 会附加 `visibleInUi`、`total`、`waitedSeconds`
- 任务对象带 `remainingBytes`（剩余字节）与 `etaSeconds`（预估剩余秒数，仅在正在下载且速度有效时出现；用指数平滑后的速度计算，避免秒级抖动）

---

## 配套工具：doh_lookup 与 http_probe

这两个工具与 `downloader` 并列注册，共用插件内的网络模块，但**不创建下载任务、不占连接配额**，任何会话都能直接调用。

### doh_lookup

用 DNS over HTTPS 解析域名，不依赖本机 DNS。本机 DNS 被污染时，先拿到真实 IP，再用 `curl --resolve`、Host 头或 `http_probe` 的 `doh` 选项直连。

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | string | 单个域名；传 IP 时原样返回 |
| `names` | string[] | 批量域名，最多 20 个 |
| `type` | string | 默认 `A`；`both` = A + AAAA；也支持 CNAME / TXT / MX / NS / SOA / PTR / SRV / CAA / HTTPS |
| `provider` | string | `cloudflare` / `alidns` / `tencent`，默认用插件设置 |
| `fresh` | bool | 跳过 60 秒缓存 |

```json
{ "name": "github.com", "type": "both" }
```

返回 `{ ok, provider, results, addresses }`：

- `results[]`：每个查询的 `name` / `type` / `status` / `cached` / `ms` / `records[{ type, ttl, data }]`
- `addresses[]`：A/AAAA 记录整理成的 `{ name, address, family }`

### http_probe

只发 HEAD，必要时补一个 `bytes=0-0` 的 Range 请求，**不下载正文**。下载前确认能否分片、断点续传是否可信，或诊断 403/防盗链。

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string | 要探测的 http/https 地址 |
| `headers` | object | Cookie / Referer / Authorization 等；Range 等下载器控制的头会被忽略 |
| `doh` | bool | 用 DoH 解析该地址 |
| `dohProvider` | string | `doh=true` 时的提供商 |

```json
{ "url": "https://example.com/big.iso", "headers": { "Referer": "https://example.com/" } }
```

返回 `{ ok, url, size, ranges, filename, etag, lastModified }`；401/403 时 `error` 会说明需要哪些请求头。

---

## 作为模块复用

`lib/` 下的模块不依赖 DSH 上下文，可以被其它插件或脚本直接导入：

```js
// 包内子路径
import { createDohResolver } from 'dsh-multithread-downloader/doh'
import { probe } from 'dsh-multithread-downloader/net'
import { SiteGovernor } from 'dsh-multithread-downloader/limits'
import { fileChecksum } from 'dsh-multithread-downloader/checksum'

// 或者统一入口（按命名空间）
import { doh, net, limits, files, checksum } from 'dsh-multithread-downloader/lib'

const { addresses } = await doh.createDohResolver({ provider: 'alidns' }).resolve('example.com')
const meta = await net.probe('https://example.com/file.zip', AbortSignal.timeout(30_000))
```

| 模块 | 内容 |
|---|---|
| `lib/doh.js` | `createDohResolver`（A/AAAA/CNAME/TXT…，TTL 缓存）、`createDohDispatcher`（undici dispatcher，失败回退系统 DNS）、`resolveAddresses` |
| `lib/net.js` | `parseHttpUrl`、`sanitizeHeaders`、`fetchWithRedirects`、`probe`、`fingerprintChange`、`ifRangeValue`、`retryDelay`、`resolveGithubAsset` |
| `lib/limits.js` | `ConnectionSlots`、`RateLimiter`、`LoadGovernor`、`ResourceSampler`、`SiteGovernor`、`siteKeyForUrl` |
| `lib/files.js` | `defaultDownloadDirectory`、`browseDirectory`、`sanitizeFilename`、`uniqueName`、`freeDiskBytes`、`autoThreadsForBytes` |
| `lib/checksum.js` | `fileChecksum`（md5/sha1/sha256/sha512/crc32）、`normalizeChecksum` |

自定义 DoH 端点（例如自建解析服务）可传 `createDohResolver({ provider, endpoint })`。

---

## 本地 HTTP API

前缀：`/api/mtd`

仅接受本机 loopback + 同源请求。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/state` | POST | 面板任务、设置、统计 |
| `/add` | POST | 新建下载（`origin=user`） |
| `/control` | POST | `pause/resume/cancel/remove` |
| `/settings` | POST | 更新设置 |
| `/summary` | POST | 侧边栏/进度条汇总 |
| `/browse` | POST | 目录浏览 |
| `/pick-directory` | POST | 调用系统原生目录选择器 |

`/state` 在并发相关字段上区分三层语义：

- `maxConnections`：用户设定的连接上限；
- `effectiveConnections`：考虑设备负载后实际生效的预算（`activeConnections` 是当前已占用数）；
- `resources`：`{ cpuPct, memoryPct, pressure, level, baseConnections, effectiveConnections, sampledAt }`，`level` 为 `normal / elevated / high / critical`，采样关闭时 `enabled=false`；
- `sites`：当前被限速的站点，元素为 `{ key, level, connections, rateBytes, cooldownUntil, signals, lastStatus }`；
- `loadAdaptive` / `siteAdaptive`：两个自适应开关的当前值（`POST /settings` 同名字段可改）。

任务快照在站点受限时额外带 `siteThrottle`（`level / connections / rateBytes / cooldownUntil`）与 `siteKey`；因风控重试过时还带 `riskRetries` 与 `riskNote`。

示例：

```bash
curl -X POST http://127.0.0.1:60437/api/mtd/add \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/a.zip","threads":8}'
```

---

## 文件与路径

### 默认下载目录

优先级：

1. 配置 `directory`
2. Windows Downloads Known Folder
3. Linux `XDG_DOWNLOAD_DIR`
4. macOS `~/Downloads`
5. 用户主目录下的 `Downloads` 回退

Windows 支持被重定向到 OneDrive/其他盘。

### 目录选择器

- Windows：随包 `bin/picker.exe`，调用 `IFileOpenDialog`
- macOS：`osascript`
- Linux：`zenity` / `kdialog`
- 失败回退插件内目录浏览器

### 临时文件

下载中的文件为：

```text
<目标文件>.mtd-part
```

取消会删除；暂停/失败保留。

---

## 安全说明

- 本地 API 仅监听 loopback，并校验 Host/Origin
- 跨域重定向时剥离 Cookie / Authorization / Proxy-Authorization
- 请求头会明文保存在 profile，敏感 Cookie 请自行评估
- 插件可向用户指定目录写文件；不要对不可信 Agent 开放任意路径
- DoH 会把 DNS 查询交给第三方，失败会回退系统 DNS
- `bin/picker.exe` 未签名，Windows 可能触发 SmartScreen
- 不接管浏览器登录态，不自动读取 Cookie

---

## 限制与非目标

只支持 HTTP/HTTPS 直链。

明确不支持、也不会实现：

- FTP / SFTP
- BT / 磁力 / Metalink
- 浏览器扩展接管、自动登录态
- 系统代理 / 自定义代理
- HLS / DASH 流媒体

其他限制：

- GitHub API 未认证额度有限
- 非标准 5xx（如 567）不会重试
- DoH 提供商可能不可达
- 私有 GitHub 仓库不支持
- 无代码签名

---

## 故障排查

### 401 / 403 / 407

提供请求头：

```json
{ "headers": { "Cookie": "…", "Referer": "https://…" } }
```

### GitHub 直链 `fetch failed`

本机 `github.com` 可能被 DNS 污染：

- 开启 GitHub 模式
- 或启用 DoH
- 或使用 `api.github.com/.../releases/assets/<id>`

### 非标准 5xx（如 567）

通常是 CDN 限流：

- 降低线程数
- 降低全局限速
- 等待冷却后重试

### 曲线不显示

- 任务大小低于静默阈值且未设置 `forceDisplay`
- 历史采样不足（刚创建/完成太快）
- 页面未刷新到新客户端

### 速度远低于限速

全局限速是上限，不是保底；实际速度受服务器/网络/连接数限制。

### 一直「下载中」，速度只有几 B/s

这是半死连接（CDN 边缘节点、中间设备限流、TLS 后卡住但 TCP 没断）。1.5.1 起默认开启停滞看门狗：窗口内吞吐过低会换一组新连接，最多两次；两次都还是涓流就标记「远端极慢」（任务不会失败，只是不再自动换连接）。如果确实是源站极慢，可以关掉看门狗，或者继续等。

### 中文路径显示成乱码

1.4.0 之前有两个已知来源，都已修复：Windows 默认下载目录是从 `reg.exe` 读的，它按系统 OEM 代码页（中文系统是 GBK）写管道，按 UTF-8 解码就成了乱码；服务器用 GBK 直接写 `Content-Disposition: filename="中文.zip"` 时，文件名会变成乱码。现在两处都会先按 UTF-8 尝试、失败再回退 GBK。若仍看到乱码：

- 升级到包含该修复的版本（Host 需重启，客户端需刷新页面）
- 确认不是浏览器/终端字体问题：面板里 `dir` 字段和磁盘上的实际目录名要一致

### 页面仍显示旧界面

刷新浏览器页面；客户端插件更新不一定自动热加载。

---

## 开发与测试

```bash
npm test
npm pack --dry-run
```

测试覆盖（67 项，`test/host.test.mjs` 63 项 + `test/plugin.test.mjs` 4 项）：

- 请求头清洗、非法 header 名拒绝、跨域重定向剥离敏感头、探测/401 提示
- 分片下载、4 MB 分段轮转、连接预算共享与排队、单任务不超预算
- 指纹校验：ETag/Last-Modified 变化重下、续传复核、探测失败拒绝续传、If-Range 重开
- 416 不再空转、正文空闲超时释放连接槽、暂停后立即恢复只有一轮在跑
- 重启恢复为 paused 并保留 origin / forceDisplay / DoH 等字段
- 站点风控降档与恢复、站点之间互不影响、设备负载收缩
- DoH 解析与缓存、`doh_lookup` 参数校验与 IP 短路、`http_probe` 不读正文
- 中文目录与中文文件名端到端下载、GBK 响应头解码、OEM 输出解码
- 多算法校验、ETA 计算、clean 释放文件名、队列中任务可暂停
- `apply()` 注册三个工具 + 七条路由，dispose 后全部撤销；`pick-directory` 探测不再抛未定义错误；工具参数与输出 schema 覆盖实现真实读取/返回的字段

CI：GitHub Actions，Node 22 / 24，Linux / Windows / macOS。

---

## 版本与发布

- 当前版本：**1.4.2**（本地已就绪，尚未发布）
- npm：`latest = 1.4.1`（1.4.2 待发布）
- GitHub Release：`v1.4.1`（v1.4.2 待发布）
- 历史版本：
  - 1.3.1：修复审查发现的问题（416 空转、任务恢复、原生目录选择器、暂停后立即恢复的竞态、正文空闲超时）
  - 1.3.0：多算法校验、`forceDisplay`、`http_probe`
  - 1.2.x：站点风控自适应与设备负载自适应
  - 1.1.1：修正 Node 最低版本
  - 1.1.0：DoH 与 GitHub 模式
  - 1.0.4：默认限速 100 MB/s
  - 1.0.3：DSH 0.2.2 兼容性标记
  - 1.0.2：DSH 0.2.1-rc.5 兼容性
  - 1.0.1：CI 修复
  - 1.0.0：首个发布版本

---

## 相关文件

- `README.md`：快速开始
- `CHANGELOG.md`：版本记录
- `SECURITY.md`：安全说明
- `PUBLISHING.md`：发布清单
- `MARKETPLACE.md`：市场信息
- `docs/screenshots/`：界面截图
- `bin/picker.cs` / `bin/picker.exe`：Windows 目录选择器
