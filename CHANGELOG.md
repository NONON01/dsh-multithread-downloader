# Changelog

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
