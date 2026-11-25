# 社区目录投稿素材

这里放的是提交给社区插件目录所需的内容，**不是 npm 包的一部分**（`package.json` 的 `files` 白名单没有 `marketplace/`）。

## 投稿前的现状核对（2026-11-26 查证）

| 门槛 | 要求 | 我们的状态 |
|---|---|---|
| `dsh-plugin` topic | 必须 | ✅ 已有（topics 里含 `dsh-plugin`） |
| `dsh.bundle` 声明 | 必须，且 patch 文件要在仓库里 | ✅ `dsh.bundle.patch = ./cordis.patch.yml`，文件已提交 |
| 真实可运行代码 | 必须 | ✅ 三个工具 + 面板 + 57 项测试 |
| GitHub 简介 | 部分目录要求 | ⚠️ 有，但可以更具体（见下） |
| 仓库创建满 1 天 | awesome-dsh-plugin 硬性 | ✅ 2026-10-25 创建，已 31 天 |
| Star > 10 | awesome-dsh-plugin-pro 自荐硬性 | ❌ 当前 0，暂不投 pro |
| npm 已发布 | 1024 Store 才显示安装命令；无也能「仅浏览」收录 | ✅ npm `latest = 1.4.0`，GitHub Release `v1.4.0` 已发布 |

**现状**：远程 `main`、npm、GitHub Release 都已是 1.4.0（2026-11-26）。下面三份描述里提到的 `doh_lookup` / `http_probe` / ETA 都能在代码里核实，可以按顺序投了。

## 一、awesome-dsh-plugin（25.6k star，最核心，必投）

- 仓库：`awesome-dsh-plugin/awesome-dsh-plugin`
- 只新增一个文件：`data/plugins/NONON01__dsh-multithread-downloader.yml`
- 内容：`awesome-dsh-plugin.yml`（本目录）
- 已核对的规则：只改这一个文件；`description.en` 必填、以句号结尾、只陈述功能；含 `: ` 的字符串要加引号（我们用了单引号）；`category` 取 `tools`；仓库满 1 天由 CI 自动校验（已满足）
- PR 标题：`Add NONON01/dsh-multithread-downloader`

## 二、imsai-sh/awesome-deepseek-harness-plugins（1024 Store 数据源）

- 只新增一个文件：`catalog/plugins/nonon01--dsh-multithread-downloader.json`
- 内容：`imsai-catalog.json`（本目录），字段与官方 schema 一致（`$schema`/`id`/`name`/`repository`/`category`/`description.en|zh`/`added`）
- 文件名规则：id 每段小写、非字母数字转 `-`、用 `--` 连接 → `nonon01--dsh-multithread-downloader.json`
- 静态门禁会读 GitHub API 校验 `dsh.bundle.patch` 及其文件存在（已满足）；不会因为没发 npm 拒收，只是标为「仅浏览」
- 合并后自动同步到 deepseek1024.com 并重建 README
- PR 标题：`Add NONON01/dsh-multithread-downloader`

## 三、JasperPengC/awesome-dsh-plugins（低门槛补充）

- 在 `plugins/tools.md` 末尾加一行：`jasper-tools-line.md`（本目录）
- PR 标题：`Add dsh-multithread-downloader to tools`

## 四、暂不投：awesome-dsh-plugin-pro

自荐区要求 `stargazers_count > 10`，当前 0 star，CI 会直接拒。等 star 过 10 再投其 `SHOWCASE.md`（中英各追加一行）。

## 五、自动发现（1024 Store）

topic `dsh-plugin` 已在，仓库已进自动收集队列，不需要额外动作；npm 发布 1.4.0 后安装命令会自动出现。

## 六、GitHub About / Topics 建议

当前的简介偏泛，建议换成（客观、具体、无营销词）：

```
HTTP/HTTPS multi-thread downloader for DeepSeek Harness: downloader, doh_lookup and http_probe tools, resume with ETag verification, adaptive concurrency.
```

Topics 可补：`agent-tool`、`resumable-download`、`http-downloader`（现有 7 个已含 `dsh-plugin`）。

写入命令见 [PUBLISHING.md](../PUBLISHING.md) 的「GitHub 仓库设置」一节。**这些是对外改动，等你确认后再执行。**
