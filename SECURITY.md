# Security Policy

## 报告方式

请通过仓库的私密安全报告渠道联系维护者，不要在公开 Issue 中贴出利用细节。

## 范围

- 本地 `/api/mtd/*` 路由：仅监听 loopback，并校验 Host/Origin（见下）
- 自定义请求头会写到 profile 目录，敏感 Cookie 请自行评估
- `bin/picker.exe` 为随包原生助手，源码在 `bin/picker.cs`，可复现构建

## 本地 HTTP 路由的访问检查

`/api/mtd/*` 挂在 DSH 自己的 Web 服务上（默认只监听 `127.0.0.1`），**没有** DSH 层面的登录态，
所以插件在 `isTrustedRequest()` 里自己做了三道检查：

1. 连接必须来自 loopback：`remoteAddress` 是 `127.0.0.0/8` 或 `::1`
2. `Host` 必须是 loopback 主机名；带 `X-Forwarded-For` / `CF-Connecting-IP` 的一律拒绝
3. 浏览器请求：`Sec-Fetch-Site: cross-site` 直接拒绝，`same-origin` 放行，
   剩下的比对 `Origin` 与 `Host` 是否同源

v1.5.0 实测（curl 复现浏览器会发送的请求头）：

| 场景 | 关键请求头 | 结果 |
|---|---|---|
| 本机脚本 / 工具 | 无 `Origin` | 200 |
| 恶意网页的 cross-site fetch | `Origin: https://evil.example` + `Sec-Fetch-Site: cross-site` | 403 |
| 只给 Origin、不给 Sec-Fetch-Site | `Origin: https://evil.example` | 403 |
| DNS rebinding（域名解析到 127.0.0.1） | `Host: evil.example` | 403 |
| localhost 页面打 127.0.0.1 的端口 | `Origin: http://localhost:56973` | 403 |
| DSH 面板自身 | `Origin: http://127.0.0.1:56973` | 200 |

结论：**浏览器里打开的网页调用不到这些路由**。能调用的是本机进程和浏览器扩展 —— 它们可以任意
构造请求头，也本来就与插件同权限，所以不构成提权路径。真正要守的是端口本身：不要把 DSH 的 Web
端口绑到 `0.0.0.0`，也不要放在反向代理后面对外暴露（那样 `Host` 就不再是 loopback，路由会全部
拒绝，属于预期行为）。

## 已知边界

- 插件可向用户指定目录写入文件；不要对不可信 Agent 开放任意路径
- 跨域重定向时会**剥离** `cookie` / `authorization` / `proxy-authorization`（见 `lib/net.js`），同源跳转仍会带上；即便如此，敏感头也只应用于可信地址
- 未完成任务的 `headers` 会以明文保存在 profile 目录（`multithread-downloader-tasks.json`），存放位置与 DSH 配置文件同级，权限跟随当前用户
