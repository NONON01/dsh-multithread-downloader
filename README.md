# 多线程下载器（DSH 插件）

Host 端用 HTTP Range 分片并发下载，Web GUI 提供侧边栏面板、对话进度条与未完成计数；同时向 agent 注册 `downloader` 工具和 `multithread-downloader` 技能。

## 安装

在 DSH 插件管理里把本包作为 bundle 安装（本地目录或 registry 包），重启/热重载后生效。

- 包名：`dsh-multithread-downloader`
- npm：https://www.npmjs.com/package/dsh-multithread-downloader
- 安装：`npm i dsh-multithread-downloader`
- 最低 DSH：`>=0.2.1-rc.2`
- Node：`>=20`

## 兼容性

只支持 HTTP/HTTPS 直链。FTP/SFTP、BT、浏览器接管、代理、HLS/DASH 均为非目标，详见“限制与非目标”。

## 功能

- 自定义请求头（Cookie / Referer / Authorization），401/403 给出明确提示
- 分片指数退避重试、请求超时、镜像回退、批量 URL
- SHA-256 校验与下载前磁盘空间检查
- 全局限速与同时任务数（超额排队）
- 未完成任务持久化，插件重载/DSH 重启后以暂停状态恢复

- HTTP/HTTPS 分片并发下载，服务器不支持 Range 时自动回退单连接
- 暂停 / 续传 / 取消 / 移除；续传前校验大小、ETag、Last-Modified，远端变化则从头下载
- 服务器中途忽略 Range 时自动降级为单连接重下
- 面板目录选择：Windows 使用随包原生助手调资源管理器同款 `IFileOpenDialog`（自定义标题、owner 置前）；Electron 宿主优先用 Electron 对话框；其他环境回退插件内目录浏览器
- 大文件进度曲线（面板），多任务分段进度条（对话输入框上方）
- 侧边栏未完成计数
- 静默下载阈值：小于阈值的任务不在界面显示（可关闭）
- 单线程阈值：小于阈值的任务不分片（可开关）
- Agent 自主模式：默认开启；阈值设置被屏蔽但仍约束 Agent 任务，用户手动下载不受影响
- 设置与未完成任务持久化到 profile 目录
- Windows 原生目录选择器；macOS/Linux 使用系统命令，失败回退插件内浏览器

## 默认下载目录

- Windows：读取 `HKCU\...\User Shell Folders` 的 Downloads Known Folder，支持被重定向到 OneDrive / 其他盘；读取失败时回退 `%USERPROFILE%\Downloads`
- Linux：读取 `~/.config/user-dirs.dirs` 的 `XDG_DOWNLOAD_DIR`，回退 `~/Downloads`
- macOS：`~/Downloads`
- 配置里的 `directory` 优先级最高

## 配置（`cordis.patch.yml`）

```yaml
threads: 4              # 默认分片数 1..16
maxConcurrent: 3        # 同时下载任务数
largeFileMb: 16         # 静默下载阈值（MB），仅作为首次默认值
silentEnabled: true     # 是否启用静默阈值
minThreadMb: 4          # 单连接阈值（MB）
minThreadEnabled: true  # 是否启用单连接阈值
agentAutonomy: true     # 默认开启；阈值设置屏蔽但继续约束 Agent 任务
announceToAgent: true   # 是否注入系统提示公告
rateLimitKb: 0          # 全局限速 KB/s，0 不限
```

## 原生目录选择器

`bin/picker.exe` 是一个几 KB 的 .NET Framework 助手，调用 Windows `IFileOpenDialog`（资源管理器同款文件夹对话框）：支持自定义标题、初始目录，并在打开后主动置前。源码在 `bin/picker.cs`，可用 `csc` 重新编译；选择器不可用或被取消时会自动回退到插件内目录浏览器。

## 开发与测试

```bash
npm test
npm pack --dry-run
```

安全说明见 [SECURITY.md](SECURITY.md)，发布清单见 [PUBLISHING.md](PUBLISHING.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 限制与非目标

只支持 HTTP/HTTPS 直链。以下能力**已明确放弃、不会实现**：

- FTP / SFTP
- BT / 磁力 / Metalink
- 浏览器扩展接管、浏览器登录态/Cookie 自动读取
- 系统代理或自定义代理配置
- HLS / DASH 等流媒体协议

其它限制：

- 需要登录或防盗链的资源，必须显式通过 `headers` 提供 Cookie / Referer / Authorization，本插件不接管浏览器会话
- 自定义请求头会随未完成任务明文保存在 profile 目录，使用敏感 Cookie 时注意本机权限
- 跨域重定向时 `Authorization` 由 fetch 按规范剥离，但自定义 `Cookie` 等头可能被转发；敏感头请只用于可信地址
- SHA-256 校验是可选能力，未提供时只校验最终字节数
- 未完成任务会在重启后恢复为暂停状态；已完成文件保留
