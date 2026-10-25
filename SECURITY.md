# Security Policy

## 报告方式

请通过仓库的私密安全报告渠道联系维护者，不要在公开 Issue 中贴出利用细节。

## 范围

- 本地 `/api/mtd/*` 路由：仅监听 loopback，并校验 Host/Origin
- 自定义请求头会写到 profile 目录，敏感 Cookie 请自行评估
- `bin/picker.exe` 为随包原生助手，源码在 `bin/picker.cs`，可复现构建

## 已知边界

- 插件可向用户指定目录写入文件；不要对不可信 Agent 开放任意路径
- 跨域重定向时自定义 Cookie 可能被转发，敏感头只应用于可信地址
