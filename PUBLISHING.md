# 发布清单

## 已就绪

- 包名 `dsh-multithread-downloader`（npm 公共 registry 当前可用）
- LICENSE (MIT)、CHANGELOG、SECURITY、PUBLISHING
- `engines.dsh >=0.2.1-rc.2`，`peerDependencies.@deepseek-ai/dsh`
- 单元/集成测试 8 项通过；CI 覆盖 Linux/Windows/macOS × Node 20/22
- `npm pack` 产物已验证可解包、入口可解析
- 明确非目标：FTP/SFTP、BT、浏览器接管、代理、HLS/DASH
- 原生助手构建脚本 `bin/build.ps1`
  - `bin/picker.exe` SHA-256：`8b4a4f2c6683fbedd26647d8a1ed306ea9c3daaaa24fd6798ee9089368dd330f`

## 发布前仍需人工完成

1. ~~仓库地址~~ 已补 `NONON01/dsh-multithread-downloader`
2. ~~作者~~ 已填 `NONON01`
3. Windows 助手签名证书（可选，未签名会触发 SmartScreen）
4. 在干净 profile 中安装 `npm pack` 产物并验证升级
5. 市场截图、分类、权限说明
6. 确认目标 registry（公共 npm 或私有 registry）

## 打包检查

```bash
npm test
npm pack --dry-run
```

## 当前本地验证

- 已以 `dsh-multithread-downloader` 重新 link 安装，工具与 `/api/mtd/state` 正常
- 旧 `@local/multithread-downloader` 依赖已从 profile 移除
