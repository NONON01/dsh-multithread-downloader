/**
 * 多线程下载器 —— Client 半边。
 *
 * 在侧边栏注册图标，在 main 面板注册下载器页面；通过 /api/mtd/* 调用 Host
 * 半边，轮询任务进度。样式只使用 --dsw-alias-* 主题 token。
 */
window.__ModuleLoader__.load({
  id: 'dsh-multithread-downloader',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'multithread-downloader'
    const API = 'api/mtd'
    const POLL_MS = 900

    const zh = {
      title: '多线程下载器',
      subtitle: 'HTTP Range 分片并发下载，保存到 dsh 所在机器',
      'form.url': '下载地址',
      'form.urlPlaceholder': 'https://example.com/file.zip',
      'form.directory': '保存目录（可选）',
      'form.directoryPlaceholder': '默认：{directory}',
      'form.threads': '线程',
      'form.browse': '选择…',
      'form.browseTitle': '选择下载目录',
      'error.pick': '选择目录失败：{message}',
      'picker.title': '选择下载目录',
      'picker.select': '选择此目录',
      'picker.cancel': '取消',
      'picker.loading': '读取中…',
      'picker.empty': '没有子目录',
      'error.list': '读取目录失败：{message}',
      'form.advanced': '高级选项（请求头 / 校验 / 批量）',
      'form.headers': '请求头，每行 Key: value',
      'form.headersPlaceholder': 'Cookie: a=b\nReferer: https://example.com/',
      'form.sha256': 'SHA-256（可选，64 位十六进制）',
      'form.batch': '批量 URL（每行一个，最多 20 个；填写后忽略上方地址）',
      'form.batchPlaceholder': 'https://example.com/a.zip\nhttps://example.com/b.zip',
      'form.batchTooMany': '一次最多批量添加 20 个地址',
      'form.submit': '开始下载',
      'form.submitting': '正在创建…',
      'stats.active': '进行中',
      'stats.finished': '已完成',
      'stats.speed': '总速度',
      'stats.tasks': '任务',
      'empty.title': '还没有下载任务',
      'empty.hint': '在上方填入下载地址，选择线程数后开始下载。',
      'status.queued': '排队中',
      'status.probing': '解析中',
      'status.downloading': '下载中',
      'status.paused': '已暂停',
      'status.completed': '已完成',
      'status.failed': '失败',
      'status.canceled': '已取消',
      'action.pause': '暂停',
      'action.resume': '继续',
      'action.cancel': '取消',
      'action.remove': '移除',
      'action.retry': '重试',
      'action.confirmCancel': '确认取消',
      'task.threads': '{count} 线程',
      'task.unknownSize': '大小未知',
      'chart.title': '大文件进度曲线',
      'chart.window': '近 {seconds} 秒',
      'chart.eta': '预计剩余 {eta}',
      'chart.average': '平均 {speed}',
      'chart.waiting': '采样中…',
      'settings.threshold': '静默下载阈值',
      'settings.thresholdUnit': 'MB',
      'settings.thresholdHint': '仅约束 Agent 任务：小于该值时静默完成，不在面板和对话中显示',
      'settings.thresholdOffHint': '已关闭：显示所有任务',
      'settings.minThreadOffHint': '已关闭：所有任务按线程数分片',
      'settings.rate': '全局限速（KB/s，0 = 不限）',
      'settings.rateHint': '所有下载共享此带宽上限',
      'settings.concurrency': '同时下载任务数',
      'settings.concurrencyHint': '多余的下载会排队',
      'settings.agentOnHint': '已开启：阈值设置已屏蔽（仍约束 Agent 任务）；手动下载始终多线程并显示',
      'settings.agentOffHint': '已关闭：面板参数可调',
      'settings.invalid': '请输入 1 KB – 10 GB 之间的数值',
      'settings.minThread': '单线程阈值',
      'settings.minThreadHint': '仅约束 Agent 任务：小于该值时不分片、单连接下载',
      'settings.minThreadInvalid': '请输入 0 – 10 GB 之间的数值',
      'settings.unit': '单位',
      'settings.minThreadEnabled': '启用单线程阈值',
      'settings.agentAutonomy': 'Agent 自主模式',
      'settings.agentAutonomyHint': '开启后阈值设置屏蔽但继续约束 Agent 任务；面板手动下载不受限制',
      'badge.unfinished': '{count} 个未完成任务',
      'dock.open': '打开面板',
      'dock.tasks': '{count} 个下载任务',
      'dock.rest': '还有 {count} 个下载任务',
      'dock.hide': '隐藏进度',
      'dock.show': '重新显示进度',
      'error.request': '无法连接 Host 下载服务：{message}',
      'error.add': '创建下载失败：{message}',
      'error.control': '操作失败：{message}',
      'directory': '保存到 {directory}',
    }

    const en = {
      title: 'Multithread Downloader',
      subtitle: 'Parallel HTTP Range downloads saved on the dsh host',
      'form.url': 'URL',
      'form.urlPlaceholder': 'https://example.com/file.zip',
      'form.directory': 'Directory (optional)',
      'form.directoryPlaceholder': 'Default: {directory}',
      'form.threads': 'Threads',
      'form.browse': 'Browse…',
      'form.browseTitle': 'Choose download directory',
      'error.pick': 'Could not pick a directory: {message}',
      'picker.title': 'Choose download directory',
      'picker.select': 'Use this folder',
      'picker.cancel': 'Cancel',
      'picker.loading': 'Loading…',
      'picker.empty': 'No subfolders',
      'error.list': 'Could not read the folder: {message}',
      'form.advanced': 'Advanced (headers / checksum / batch)',
      'form.headers': 'Request headers, one Key: value per line',
      'form.headersPlaceholder': 'Cookie: a=b\nReferer: https://example.com/',
      'form.sha256': 'SHA-256 (optional, 64 hex chars)',
      'form.batch': 'Batch URLs, one per line, max 20; overrides the URL above',
      'form.batchPlaceholder': 'https://example.com/a.zip\nhttps://example.com/b.zip',
      'form.batchTooMany': '一次最多批量添加 20 个地址',
      'form.submit': 'Start download',
      'form.submitting': 'Creating…',
      'stats.active': 'Active',
      'stats.finished': 'Completed',
      'stats.speed': 'Total speed',
      'stats.tasks': 'Tasks',
      'empty.title': 'No downloads yet',
      'empty.hint': 'Paste a URL above, choose the thread count, and start.',
      'status.queued': 'Queued',
      'status.probing': 'Probing',
      'status.downloading': 'Downloading',
      'status.paused': 'Paused',
      'status.completed': 'Completed',
      'status.failed': 'Failed',
      'status.canceled': 'Canceled',
      'action.pause': 'Pause',
      'action.resume': 'Resume',
      'action.cancel': 'Cancel',
      'action.remove': 'Remove',
      'action.retry': 'Retry',
      'action.confirmCancel': 'Confirm cancel',
      'task.threads': '{count} threads',
      'task.unknownSize': 'Unknown size',
      'chart.title': 'Large-file progress',
      'chart.window': 'Last {seconds}s',
      'chart.eta': 'ETA {eta}',
      'chart.average': 'Avg {speed}',
      'chart.waiting': 'Sampling…',
      'settings.threshold': 'Silent download threshold',
      'settings.thresholdUnit': 'MB',
      'settings.thresholdHint': 'Applies to agent tasks only: below this size they stay out of the panel and conversation strip',
      'settings.thresholdOffHint': 'Off: every task is shown',
      'settings.minThreadOffHint': 'Off: every task splits across threads',
      'settings.rate': '全局限速（KB/s，0 = 不限）',
      'settings.rateHint': '所有下载共享此带宽上限',
      'settings.concurrency': '同时下载任务数',
      'settings.concurrencyHint': '多余的下载会排队',
      'settings.rate': 'Global rate limit (KB/s, 0 = unlimited)',
      'settings.rateHint': 'Shared by all downloads',
      'settings.concurrency': 'Concurrent downloads',
      'settings.concurrencyHint': 'Extra downloads wait in the queue',
      'settings.agentOnHint': 'On: thresholds are masked but still govern agent tasks; manual downloads stay multi-threaded and visible',
      'settings.agentOffHint': 'Off: panel controls apply',
      'settings.invalid': 'Enter a value between 1 KB and 10 GB',
      'settings.minThread': 'Single-connection threshold',
      'settings.minThreadHint': 'Applies to agent tasks only: below this size they use one connection',
      'settings.minThreadInvalid': 'Enter a value between 0 and 10 GB',
      'settings.unit': 'Unit',
      'settings.minThreadEnabled': 'Enable single-connection threshold',
      'settings.agentAutonomy': 'Agent autonomy',
      'settings.agentAutonomyHint': 'Threshold settings are masked but still govern agent tasks; manual panel downloads are unrestricted',
      'badge.unfinished': '{count} unfinished downloads',
      'dock.open': 'Open panel',
      'dock.tasks': '{count} downloads',
      'dock.rest': '{count} more downloads',
      'dock.hide': 'Hide progress',
      'dock.show': 'Show progress',
      'error.request': 'Host download service unreachable: {message}',
      'error.add': 'Could not create the download: {message}',
      'error.control': 'Action failed: {message}',
      'directory': 'Saving to {directory}',
    }

    const CSS = `
.mtd-page { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; overflow: hidden; }
.mtd-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
.mtd-content { box-sizing: border-box; width: 100%; max-width: 980px; margin: 0 auto; padding: 0 clamp(24px, 4vw, 48px) 48px; }
.mtd-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; padding: 28px 0 18px; }
.mtd-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
.mtd-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; min-width: 0; }
.mtd-dir { margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 11.5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mtd-card { box-sizing: border-box; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 14px 16px; }
.mtd-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.mtd-input { box-sizing: border-box; min-width: 0; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 7px 10px; outline: none; transition: border-color .15s ease; }
.mtd-input:focus { border-color: var(--dsw-alias-brand-primary); }
.mtd-input:disabled { opacity: .6; cursor: not-allowed; }
.mtd-switch-row { display: inline-flex; align-items: center; gap: 6px; }
.mtd-toggle { position: relative; flex: none; width: 28px; height: 16px; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-2); cursor: pointer; transition: background-color .15s ease, border-color .15s ease, opacity .15s ease; }
.mtd-toggle::after { content: ''; position: absolute; top: 1px; left: 1px; width: 12px; height: 12px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: transform .15s ease, background-color .15s ease; }
.mtd-toggle.on { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.mtd-toggle.on::after { transform: translateX(12px); background: var(--dsw-alias-label-primary-foreground, #fff); }
.mtd-toggle:disabled { cursor: not-allowed; opacity: .45; }
.mtd-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.mtd-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: .8; }
.mtd-grow { flex: 1 1 280px; }
.mtd-dirinput { flex: 1 1 170px; }
.mtd-select { flex: 0 0 auto; cursor: pointer; }
.mtd-btn { box-sizing: border-box; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 5px 14px; cursor: pointer; white-space: nowrap; transition: border-color .15s ease, background-color .15s ease, color .15s ease; }
.mtd-btn:hover:enabled { border-color: var(--dsw-alias-label-secondary); }
.mtd-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.mtd-btn:disabled { opacity: .5; cursor: default; }
.mtd-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent; padding: 6px 18px; }
.mtd-danger:hover:enabled { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.mtd-settings { display: flex; flex-direction: column; gap: 6px; margin: -2px 2px 14px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.mtd-setting-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mtd-unit { flex: none; padding: 4px 6px; }
.mtd-threshold { width: 76px; flex: none; padding: 4px 8px; }
.mtd-setting-unit { flex: none; }
.mtd-setting-hint { flex: 1 1 160px; min-width: 0; opacity: .8; font-size: 11px; }
.mtd-stats { display: flex; flex-wrap: wrap; gap: 8px 22px; color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 14px 2px 12px; }
.mtd-stats b { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.mtd-banner { margin-bottom: 12px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); border-radius: 8px; padding: 8px 12px; font-size: 12px; overflow-wrap: anywhere; }
.mtd-list { display: flex; flex-direction: column; gap: 10px; }
.mtd-task { margin-bottom: 0; }
.mtd-task-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mtd-task-name { flex: 1 1 auto; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mtd-chip { flex: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 0 9px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.mtd-chip.downloading, .mtd-chip.probing { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); }
.mtd-chip.completed { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
.mtd-chip.failed { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.mtd-chip.paused { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }
.mtd-pct { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.mtd-bar { height: 6px; margin: 10px 0 8px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-secondary) 18%, transparent); overflow: hidden; }
.mtd-fill { height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary); transition: width .3s ease; }
.mtd-fill.completed { background: var(--dsw-alias-state-success-primary); }
.mtd-fill.failed { background: var(--dsw-alias-state-error-primary); }
.mtd-fill.paused { background: var(--dsw-alias-state-warn-primary); }
.mtd-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.mtd-url { flex: 1 1 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 11px; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); }
.mtd-actions { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.mtd-task-error { margin-top: 8px; color: var(--dsw-alias-state-error-primary); font-size: 11.5px; overflow-wrap: anywhere; }
.mtd-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; background: color-mix(in srgb, #000 35%, transparent); }
.mtd-modal-card { display: flex; flex-direction: column; width: min(560px, 100%); max-height: min(70vh, 600px); overflow: hidden; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; box-shadow: 0 18px 50px rgba(0, 0, 0, .25); }
.mtd-modal-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mtd-modal-title { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 600; }
.mtd-crumbs { display: flex; gap: 2px; padding: 8px 10px; overflow-x: auto; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mtd-crumb { flex: none; max-width: 160px; padding: 2px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; border-radius: 4px; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; }
.mtd-crumb:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mtd-modal-body { flex: 1 1 auto; min-height: 180px; max-height: 360px; padding: 6px; overflow-y: auto; }
.mtd-dir { display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: 6px; background: none; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.mtd-dir:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mtd-dir.hidden { opacity: .6; }
.mtd-modal-note { padding: 16px; color: var(--dsw-alias-label-secondary); font-size: 12px; text-align: center; }
.mtd-modal-error { padding: 12px; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.mtd-modal-foot { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.mtd-modal-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }
.mtd-advanced { padding: 0; }
.mtd-advanced summary { padding: 10px 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; list-style: none; }
.mtd-advanced summary::-webkit-details-marker { display: none; }
.mtd-advanced[open] summary { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mtd-advanced-label { display: block; margin: 10px 12px 4px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.mtd-advanced .mtd-input { box-sizing: border-box; width: calc(100% - 24px); margin: 0 12px 4px; }
.mtd-advanced-text { resize: vertical; font-family: var(--ds-font-family-code, ui-monospace, monospace); }
.mtd-setting-label { flex: none; min-width: 96px; font-size: 12px; color: var(--dsw-alias-label-primary); }
.mtd-empty { text-align: center; padding: 40px 0 48px; }
.mtd-empty-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.mtd-empty-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.mtd-icon { display: inline-flex; align-items: center; justify-content: center; }
/* 让侧边栏的面板行成为定位容器，徽标才能贴到这一行的最右侧。 */
button:has(> span > .mtd-icon) { position: relative; }
.mtd-badge { position: absolute; z-index: 2; top: 50%; right: 10px; transform: translateY(-50%); box-sizing: border-box; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground, #fff); font-size: 10px; font-weight: 600; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; pointer-events: none; box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-layer-1); }
.mtd-icon-corner { position: relative; }
.mtd-badge-corner { top: -5px; right: -7px; transform: none; }
.mtd-dock { display: flex; align-items: center; gap: 8px; box-sizing: border-box; width: calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px)); max-width: var(--dsh-composer-card-max-width, 952px); margin: 0 auto; padding: 7px 10px; font: inherit; color: inherit; text-align: left; cursor: pointer; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.mtd-dock:hover { border-color: var(--dsw-alias-label-secondary); }
.mtd-dock-main { display: flex; flex-direction: column; gap: 5px; flex: 1 1 auto; width: auto; min-width: 0; margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.mtd-dock-main:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 6px; }
.mtd-dock-hide { flex: none; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: pointer; transition: border-color .15s ease, background-color .15s ease, color .15s ease; }
.mtd-chevron { display: block; }
.mtd-dock-restore { display: flex; align-items: center; justify-content: center; gap: 7px; box-sizing: border-box; width: max-content; max-width: 100%; height: 22px; margin: 0 auto; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 1; cursor: pointer; }
.mtd-dock-restore:hover { border-color: var(--dsw-alias-label-secondary); color: var(--dsw-alias-label-primary); }
.mtd-dock-restore:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.mtd-dock-hide:hover { border-color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mtd-dock-hide:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.mtd-dock-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mtd-dock-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.mtd-dock-meta { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mtd-dock-bar { display: flex; align-items: stretch; gap: 3px; height: 5px; }
.mtd-dock-seg { display: block; min-width: 3px; height: 100%; border-radius: 2px; background: color-mix(in srgb, var(--dsw-alias-label-secondary) 22%, transparent); box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--dsw-alias-label-secondary) 35%, transparent); overflow: hidden; }
.mtd-dock-seg-fill { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary); transition: width .3s ease; }
@media (prefers-reduced-motion: reduce) { .mtd-dock-seg-fill { transition: none; } }
.mtd-chart-waiting { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.mtd-chart { margin-top: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 8px 10px 6px; }
.mtd-chart-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin-bottom: 4px; }
.mtd-chart-title { font-size: 11.5px; font-weight: 600; }
.mtd-chart-meta, .mtd-chart-eta { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.mtd-chart-eta { margin-left: auto; }
.mtd-chart-plot { position: relative; height: 88px; }
.mtd-chart-svg { display: block; width: 100%; height: 100%; }
.mtd-chart-grid { stroke: var(--dsw-alias-border-l1); stroke-width: 1; stroke-dasharray: 3 4; opacity: .8; vector-effect: non-scaling-stroke; }
.mtd-chart-area { fill: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); stroke: none; }
.mtd-chart-line { fill: none; stroke: var(--dsw-alias-brand-primary); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; transition: stroke .2s ease; }
.mtd-chart-line.paused { stroke: var(--dsw-alias-state-warn-primary); }
.mtd-chart-line.completed { stroke: var(--dsw-alias-state-success-primary); }
.mtd-chart-area.paused { fill: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
.mtd-chart-area.completed { fill: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.mtd-chart-dot { position: absolute; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); animation: mtd-pulse 1.8s ease-out infinite; }
@keyframes mtd-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) { .mtd-chart-dot { animation: none; } .mtd-fill { transition: none; } }
@media (max-width: 560px) { .mtd-dir { margin-left: 0; } .mtd-actions { margin-left: 0; } }
`

    function formatBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let index = 0
      let size = bytes
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
    }

    function formatSpeed(value) {
      return `${formatBytes(value)}/s`
    }

    /** 以指定单位格式化，规则与 formatBytes 一致。 */
    function formatBytesIn(bytes, unitIndex) {
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      const size = Number(bytes) / 1024 ** unitIndex
      if (!Number.isFinite(size) || size < 0) return `0 ${units[unitIndex]}`
      return `${size >= 100 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`
    }

    function unitIndexFor(bytes) {
      let index = 0
      let size = Number(bytes)
      while (size >= 1024 && index < 4) {
        size /= 1024
        index += 1
      }
      return index
    }

    /** 已下载 / 总大小：按总大小选定单位，两边统一。 */
    function formatBytePair(received, total) {
      if (!(total > 0)) return formatBytes(received)
      const index = unitIndexFor(total)
      return `${formatBytesIn(received, index)} / ${formatBytesIn(total, index)}`
    }

    /** 秒数 → 紧凑的 m:ss / h:mm:ss。 */
    function formatEta(seconds) {
      const total = Math.max(0, Math.round(seconds))
      if (total < 60) return `${total}s`
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const rest = total % 60
      if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
      return `${minutes}:${String(rest).padStart(2, '0')}`
    }

    function ProgressChart({ task, t }) {
      const history = task.history
      const points = Array.isArray(history) && history.length > 0 ? history : [{ t: 0, p: 0, s: 0 }]
      const last = points[points.length - 1]
      const span = Math.max(1, last.t)
      const width = 600
      const height = 120
      const inset = 4
      const y = (p) => height - inset - Math.max(0, Math.min(1, p)) * (height - inset * 2)
      const x = (seconds) => (Math.max(0, Math.min(span, seconds)) / span) * width
      const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)} ${y(point.p).toFixed(1)}`).join(' ')
      const area = `${line} L${width} ${height} L0 ${height} Z`

      const remaining = task.totalBytes - task.receivedBytes
      const eta = task.status === 'downloading' && task.speed > 0 && remaining > 0 ? remaining / task.speed : 0
      const average = task.status === 'completed' && task.startedAt > 0 && task.finishedAt > task.startedAt
        ? task.totalBytes / ((task.finishedAt - task.startedAt) / 1000)
        : last.t > 0 ? task.receivedBytes / last.t : 0

      return h(
        'div',
        { className: 'mtd-chart' },
        h(
          'div',
          { className: 'mtd-chart-head' },
          h('span', { className: 'mtd-chart-title' }, t('chart.title')),
          h('span', { className: 'mtd-chart-meta' }, fill(t('chart.window'), { seconds: span })),
          average > 0 ? h('span', { className: 'mtd-chart-meta' }, fill(t('chart.average'), { speed: formatSpeed(average) })) : null,
          eta > 0 ? h('span', { className: 'mtd-chart-eta' }, fill(t('chart.eta'), { eta: formatEta(eta) })) : null,
        ),
        h(
          'div',
          { className: 'mtd-chart-plot' },
          h(
            'svg',
            {
              className: 'mtd-chart-svg',
              viewBox: `0 0 ${width} ${height}`,
              preserveAspectRatio: 'none',
              role: 'img',
              'aria-label': `${t('chart.title')} ${Math.round(last.p * 100)}%`,
            },
            [0.25, 0.5, 0.75].map((ratio) =>
              h('line', {
                key: ratio,
                className: 'mtd-chart-grid',
                x1: 0,
                x2: width,
                y1: y(ratio),
                y2: y(ratio),
              }),
            ),
            h('path', { className: `mtd-chart-area ${task.status}`, d: area }),
            h('path', { className: `mtd-chart-line ${task.status}`, d: line }),
          ),
          task.status === 'downloading'
            ? h('span', {
                className: 'mtd-chart-dot',
                style: { left: `${(x(last.t) / width) * 100}%`, top: `${(y(last.p) / height) * 100}%` },
              })
            : null,
        ),
      )
    }

    function fill(template, values) {
      let text = template
      for (const [key, value] of Object.entries(values)) text = text.split(`{${key}}`).join(String(value))
      return text
    }

    async function call(path, body) {
      let response
      try {
        response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
      const text = await response.text()
      let data
      try {
        data = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`)
      return data
    }

    /**
     * 侧边栏徽标与对话进度条共用的汇总状态：只在有订阅者时轮询 /summary，
     * 1 秒一次；字段没变化就不通知 React，空闲时几乎没有开销。
     */
    const EMPTY_SUMMARY = { unfinished: 0, active: 0, totalBytes: 0, receivedBytes: 0, speed: 0, top: null, tasks: [] }
    const summaryState = { data: EMPTY_SUMMARY, listeners: new Set(), timer: null, inFlight: false }

    function refreshSummary() {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (summaryState.inFlight) return
      summaryState.inFlight = true
      call(`${API}/summary`, {})
        .then((data) => {
          const next = {
            unfinished: Number(data.unfinished) || 0,
            active: Number(data.active) || 0,
            totalBytes: Number(data.totalBytes) || 0,
            receivedBytes: Number(data.receivedBytes) || 0,
            speed: Number(data.speed) || 0,
            top: data.top ?? null,
            tasks: Array.isArray(data.tasks) ? data.tasks : [],
          }
          if (JSON.stringify(next) === JSON.stringify(summaryState.data)) return
          summaryState.data = next
          for (const listener of summaryState.listeners) listener()
        })
        .catch(() => {})
        .finally(() => {
          summaryState.inFlight = false
        })
    }

    function subscribeSummary(listener) {
      summaryState.listeners.add(listener)
      if (summaryState.listeners.size === 1) {
        refreshSummary()
        summaryState.timer = setInterval(refreshSummary, 1000)
      }
      return () => {
        summaryState.listeners.delete(listener)
        if (summaryState.listeners.size === 0 && summaryState.timer !== null) {
          clearInterval(summaryState.timer)
          summaryState.timer = null
        }
      }
    }

    function useSummary() {
      const [data, setData] = React.useState(summaryState.data)
      React.useEffect(() => subscribeSummary(() => setData(summaryState.data)), [])
      return data
    }

    function useDownloads(onError) {
      const [state, setState] = React.useState({ loading: true, tasks: [], meta: null, error: '' })
      const [nonce, setNonce] = React.useState(0)
      const errorRef = React.useRef(onError)
      errorRef.current = onError

      React.useEffect(() => {
        let live = true
        let timer
        const tick = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            timer = setTimeout(tick, POLL_MS)
            return
          }
          try {
            const data = await call(`${API}/state`, {})
            if (!live) return
            setState({ loading: false, tasks: data.tasks ?? [], meta: data, error: '' })
          } catch (error) {
            if (!live) return
            const message = error instanceof Error ? error.message : String(error)
            setState((previous) => ({ ...previous, loading: false, error: message }))
            if (typeof errorRef.current === 'function') errorRef.current(message)
          } finally {
            if (live) timer = setTimeout(tick, POLL_MS)
          }
        }
        tick()
        return () => {
          live = false
          clearTimeout(timer)
        }
      }, [nonce])

      const refresh = React.useCallback(() => setNonce((value) => value + 1), [])
      return { ...state, refresh }
    }

    function StatusChip({ status, t }) {
      return h('span', { className: `mtd-chip ${status}` }, t(`status.${status}`))
    }

    function TaskRow({ task, t, onControl, busy, thresholdBytes }) {
      const [confirming, setConfirming] = React.useState(false)
      React.useEffect(() => {
        if (!confirming) return undefined
        const timer = setTimeout(() => setConfirming(false), 4000)
        return () => clearTimeout(timer)
      }, [confirming])
      React.useEffect(() => {
        setConfirming(false)
      }, [task.status])
      const percent = task.totalBytes > 0 ? Math.min(100, Math.round(task.progress * 100)) : 0
      const total = task.totalBytes > 0 ? formatBytePair(task.receivedBytes, task.totalBytes) : `${formatBytes(task.receivedBytes)} / ${t('task.unknownSize')}`
      const running = task.status === 'downloading' || task.status === 'probing' || task.status === 'queued'
      const actions = []
      if (running) actions.push(['pause', t('action.pause'), task.status !== 'queued'])
      if (task.status === 'paused' || task.status === 'failed') actions.push(['resume', task.status === 'failed' ? t('action.retry') : t('action.resume'), true])
      if (running || task.status === 'paused') actions.push(['cancel', t('action.cancel'), true])
      if (!running && task.status !== 'paused') actions.push(['remove', t('action.remove'), true])

      return h(
        'div',
        { className: 'mtd-card mtd-task' },
        h(
          'div',
          { className: 'mtd-task-head' },
          h('span', { className: 'mtd-task-name', title: task.filename || task.url }, task.filename || task.url),
          h(StatusChip, { status: task.status, t }),
          task.totalBytes > 0 ? h('span', { className: 'mtd-pct' }, `${percent}%`) : null,
        ),
        h(
          'div',
          { className: 'mtd-bar', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('div', { className: `mtd-fill ${task.status}`, style: { width: `${task.status === 'completed' ? 100 : percent}%` } }),
        ),
        h(
          'div',
          { className: 'mtd-meta' },
          h('span', null, total),
          task.status === 'downloading' ? h('span', null, formatSpeed(task.speed)) : null,
          h('span', null, fill(t('task.threads'), { count: task.threads })),
          h(
            'span',
            { className: 'mtd-actions' },
            actions.map(([action, label, enabled]) =>
              h(
                'button',
                {
                  key: action,
                  type: 'button',
                  className: `mtd-btn ${action === 'cancel' || action === 'remove' ? 'mtd-danger' : ''}`,
                  disabled: busy || !enabled,
                  onClick: () => {
                    if (action === 'cancel' && !confirming) {
                      setConfirming(true)
                      return
                    }
                    setConfirming(false)
                    onControl(task.id, action)
                  },
                },
                action === 'cancel' && confirming ? t('action.confirmCancel') : label,
              ),
            ),
          ),
        ),
        task.totalBytes >= thresholdBytes && Array.isArray(task.history) && task.history.length > 1
          ? h(ProgressChart, { task, t })
          : task.totalBytes >= thresholdBytes && task.status === 'downloading'
            ? h('div', { className: 'mtd-chart mtd-chart-waiting' }, t('chart.waiting'))
            : null,
        h('div', { className: 'mtd-url', title: task.path || task.url }, task.path || task.url),
        task.status === 'failed' && task.error !== '' ? h('div', { className: 'mtd-task-error' }, task.error) : null,
      )
    }

    /** 自绘开关：禁用时保留开/关形态，只降低不透明度。 */
    function Toggle({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: `mtd-toggle${checked ? ' on' : ''}`,
        'aria-checked': checked,
        'aria-label': label,
        disabled,
        onClick: () => {
          if (!disabled) onChange(!checked)
        },
      })
    }

    const THRESHOLD_UNIT_BYTES = { KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 }

    function pickThresholdUnit(bytes) {
      if (bytes >= THRESHOLD_UNIT_BYTES.GB) return 'GB'
      if (bytes >= THRESHOLD_UNIT_BYTES.MB) return 'MB'
      return 'KB'
    }

    function thresholdDisplay(bytes, unit) {
      const value = bytes / THRESHOLD_UNIT_BYTES[unit]
      return String(Math.round(value * 1000) / 1000)
    }

    function pickMinThreadUnit(bytes) {
      return bytes >= THRESHOLD_UNIT_BYTES.MB ? 'MB' : 'KB'
    }

    /** 目录浏览弹窗的纯展示层。 */
    function DirectoryPickerView({ t, listing, busy, error, onNavigate, onSelect, onCancel }) {
      return h(
        'div',
        { className: 'mtd-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('picker.title') },
        h(
          'div',
          { className: 'mtd-modal-card' },
          h(
            'div',
            { className: 'mtd-modal-head' },
            h('span', { className: 'mtd-modal-title' }, t('picker.title')),
            h('button', { type: 'button', className: 'mtd-btn', onClick: onCancel }, t('picker.cancel')),
          ),
          h(
            'div',
            { className: 'mtd-crumbs' },
            listing === null
              ? null
              : listing.crumbs.map((crumb) =>
                  h(
                    'button',
                    { key: crumb.path, type: 'button', className: 'mtd-crumb', title: crumb.path, onClick: () => onNavigate(crumb.path) },
                    crumb.name,
                  ),
                ),
          ),
          h(
            'div',
            { className: 'mtd-modal-body' },
            busy
              ? h('div', { className: 'mtd-modal-note' }, t('picker.loading'))
              : error !== ''
                ? h('div', { className: 'mtd-modal-error' }, fill(t('error.list'), { message: error }))
                : listing === null || listing.entries.length === 0
                  ? h('div', { className: 'mtd-modal-note' }, t('picker.empty'))
                  : listing.entries.map((entry) =>
                      h(
                        'button',
                        {
                          key: entry.path,
                          type: 'button',
                          className: `mtd-dir${entry.hidden ? ' hidden' : ''}`,
                          title: entry.path,
                          onClick: () => onNavigate(entry.path),
                        },
                        entry.name,
                      ),
                    ),
          ),
          h(
            'div',
            { className: 'mtd-modal-foot' },
            h('span', { className: 'mtd-modal-path', title: listing?.path ?? '' }, listing?.path ?? ''),
            h('button', { type: 'button', className: 'mtd-btn', onClick: onCancel }, t('picker.cancel')),
            h(
              'button',
              { type: 'button', className: 'mtd-btn mtd-primary', disabled: busy || listing === null, onClick: onSelect },
              t('picker.select'),
            ),
          ),
        ),
      )
    }

    /** 读取并浏览 Host 目录；确认后把绝对路径交回调用方。 */
    function DirectoryPicker({ t, initialPath, browse, onSelect, onCancel }) {
      const [listing, setListing] = React.useState(null)
      const [busy, setBusy] = React.useState(true)
      const [error, setError] = React.useState('')

      const load = async (path) => {
        setBusy(true)
        setError('')
        try {
          setListing(await browse(path))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      React.useEffect(() => {
        void load(initialPath)
      }, [])

      return h(DirectoryPickerView, {
        t,
        listing,
        busy,
        error,
        onNavigate: (path) => void load(path),
        onSelect: () => {
          if (listing !== null) onSelect(listing.path)
        },
        onCancel,
      })
    }

    function DownloaderPanel({ t, defaults, onBrowse }) {
      const [error, setError] = React.useState('')
      const [url, setUrl] = React.useState('')
      const [directory, setDirectory] = React.useState('')
      const [threads, setThreads] = React.useState(String(defaults.threads || 4))
      const [busy, setBusy] = React.useState(false)
      const [pickerOpen, setPickerOpen] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      const [threshold, setThreshold] = React.useState('')
      const [thresholdUnit, setThresholdUnit] = React.useState('MB')
      const [minThread, setMinThread] = React.useState('')
      const [minThreadUnit, setMinThreadUnit] = React.useState('MB')
      const [silentEnabled, setSilentEnabled] = React.useState(true)
      const [minThreadEnabled, setMinThreadEnabled] = React.useState(true)
      const [agentAutonomy, setAgentAutonomy] = React.useState(false)
      const [rate, setRate] = React.useState('0')
      const [concurrency, setConcurrency] = React.useState('3')
      const [headersText, setHeadersText] = React.useState('')
      const [sha256, setSha256] = React.useState('')
      const [batch, setBatch] = React.useState('')
      const downloads = useDownloads((message) => setError(fill(t('error.request'), { message })))

      const meta = downloads.meta
      const largeFileBytes = meta === null
        ? undefined
        : meta.largeFileBytes !== undefined
          ? meta.largeFileBytes
          : meta.largeFileMb !== undefined
            ? meta.largeFileMb * 1024 * 1024
            : undefined
      React.useEffect(() => {
        if (largeFileBytes === undefined) return
        const unit = pickThresholdUnit(largeFileBytes)
        setThresholdUnit(unit)
        setThreshold(thresholdDisplay(largeFileBytes, unit))
      }, [largeFileBytes])
      const minThreadBytes = meta === null
        ? undefined
        : meta.minThreadBytes !== undefined
          ? meta.minThreadBytes
          : meta.minThreadMb !== undefined
            ? meta.minThreadMb * 1024 * 1024
            : undefined
      React.useEffect(() => {
        if (minThreadBytes === undefined) return
        const unit = pickMinThreadUnit(minThreadBytes)
        setMinThreadUnit(unit)
        setMinThread(thresholdDisplay(minThreadBytes, unit))
      }, [minThreadBytes])

      React.useEffect(() => {
        if (meta !== null && meta.silentEnabled !== undefined) setSilentEnabled(Boolean(meta.silentEnabled))
      }, [meta === null ? undefined : meta.silentEnabled])
      React.useEffect(() => {
        if (meta !== null && meta.minThreadEnabled !== undefined) setMinThreadEnabled(Boolean(meta.minThreadEnabled))
      }, [meta === null ? undefined : meta.minThreadEnabled])
      React.useEffect(() => {
        if (meta !== null && meta.agentAutonomy !== undefined) setAgentAutonomy(Boolean(meta.agentAutonomy))
      }, [meta === null ? undefined : meta.agentAutonomy])
      React.useEffect(() => {
        if (meta !== null && meta.rateLimitBytes !== undefined) setRate(String(Math.round(meta.rateLimitBytes / 1024)))
      }, [meta === null ? undefined : meta.rateLimitBytes])
      React.useEffect(() => {
        if (meta !== null && meta.maxConcurrent !== undefined) setConcurrency(String(meta.maxConcurrent))
      }, [meta === null ? undefined : meta.maxConcurrent])
      const tasks = downloads.tasks
      const active = tasks.filter((task) => task.status === 'downloading' || task.status === 'probing' || task.status === 'queued').length
      const finished = tasks.filter((task) => task.status === 'completed').length
      const speed = tasks.reduce((sum, task) => sum + (task.status === 'downloading' ? task.speed : 0), 0)
      const thresholdBytes = largeFileBytes !== undefined ? largeFileBytes : 16 * 1024 * 1024

      const browse = async () => {
        if (picking) return
        setPicking(true)
        let fallback = false
        try {
          const result = await call(`${API}/pick-directory`, { title: t('picker.title'), initial: directory.trim() })
          if (result.native === true) {
            if (typeof result.path === 'string' && result.path !== '') setDirectory(result.path)
            return
          }
          fallback = true
        } catch {
          fallback = true
        } finally {
          setPicking(false)
        }
        if (fallback && typeof onBrowse === 'function') setPickerOpen(true)
      }

      const submit = async (event) => {
        event.preventDefault()
        const batchLines = batch.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
        const targets = batchLines.length > 0 ? batchLines : (url.trim() === '' ? [] : [url.trim()])
        if (targets.length === 0 || busy) return
        if (targets.length > 20) {
          setError(t('form.batchTooMany'))
          return
        }
        setBusy(true)
        setError('')
        try {
          const headers = parseHeaders()
          for (const target of targets) {
            await call(`${API}/add`, {
              url: target,
              directory: directory.trim(),
              threads: Number(threads),
              headers,
              sha256: targets.length === 1 ? sha256.trim() : '',
              origin: 'user',
            })
          }
          setUrl('')
          setBatch('')
          downloads.refresh()
          refreshSummary()
        } catch (failure) {
          setError(fill(t('error.add'), { message: failure instanceof Error ? failure.message : String(failure) }))
        } finally {
          setBusy(false)
        }
      }

      const parseHeaders = () => {
        const headers = {}
        for (const line of headersText.split(/\r?\n/)) {
          const index = line.indexOf(':')
          if (index <= 0) continue
          const key = line.slice(0, index).trim()
          const value = line.slice(index + 1).trim()
          if (key !== '' && value !== '') headers[key] = value
        }
        return headers
      }

      const saveRate = async () => {
        const kb = Math.round(Number(rate))
        if (!Number.isFinite(kb) || kb < 0 || kb > 1024 * 1024) {
          setError(t('settings.invalid'))
          return
        }
        await saveFlags({ rateLimitBytes: kb * 1024 })
      }

      const saveConcurrency = async (value) => {
        setConcurrency(value)
        await saveFlags({ maxConcurrent: Number(value) })
      }

      const saveThreshold = async () => {
        const value = Number.parseFloat(threshold)
        const bytes = Math.round(value * THRESHOLD_UNIT_BYTES[thresholdUnit])
        if (!Number.isFinite(bytes) || bytes < 1024 || bytes > 10 * 1024 * 1024 * 1024) {
          setError(t('settings.invalid'))
          return
        }
        if (largeFileBytes !== undefined && bytes === largeFileBytes) return
        try {
          await call(`${API}/settings`, { largeFileBytes: bytes })
          setError('')
          downloads.refresh()
        } catch (failure) {
          setError(fill(t('error.control'), { message: failure instanceof Error ? failure.message : String(failure) }))
        }
      }

      const switchThresholdUnit = (next) => {
        if (next === thresholdUnit) return
        const value = Number.parseFloat(threshold)
        if (Number.isFinite(value)) {
          const bytes = value * THRESHOLD_UNIT_BYTES[thresholdUnit]
          setThreshold(String(Math.round((bytes / THRESHOLD_UNIT_BYTES[next]) * 1000) / 1000))
        }
        setThresholdUnit(next)
      }

      const saveMinThread = async () => {
        const value = Number.parseFloat(minThread)
        const bytes = Math.round((Number.isFinite(value) ? value : 0) * THRESHOLD_UNIT_BYTES[minThreadUnit])
        if (!Number.isFinite(bytes) || bytes < 0 || bytes > 10 * 1024 * 1024 * 1024) {
          setError(t('settings.minThreadInvalid'))
          return
        }
        if (minThreadBytes !== undefined && bytes === minThreadBytes) return
        try {
          await call(`${API}/settings`, { minThreadBytes: bytes })
          setError('')
          downloads.refresh()
        } catch (failure) {
          setError(fill(t('error.control'), { message: failure instanceof Error ? failure.message : String(failure) }))
        }
      }

      const control = async (id, action) => {
        setBusy(true)
        setError('')
        try {
          await call(`${API}/control`, { id, action })
          downloads.refresh()
          refreshSummary()
        } catch (failure) {
          setError(fill(t('error.control'), { message: failure instanceof Error ? failure.message : String(failure) }))
        } finally {
          setBusy(false)
        }
      }

      const saveFlags = async (patch) => {
        try {
          await call(`${API}/settings`, patch)
          setError('')
          downloads.refresh()
        } catch (failure) {
          setError(fill(t('error.control'), { message: failure instanceof Error ? failure.message : String(failure) }))
          downloads.refresh()
        }
      }

      const switchMinThreadUnit = (next) => {
        if (next === minThreadUnit) return
        const value = Number.parseFloat(minThread)
        if (Number.isFinite(value)) {
          const bytes = value * THRESHOLD_UNIT_BYTES[minThreadUnit]
          setMinThread(String(Math.round((bytes / THRESHOLD_UNIT_BYTES[next]) * 1000) / 1000))
        }
        setMinThreadUnit(next)
      }

      const defaultDirectory = meta?.directory || defaults.directory || ''
      const settingsLocked = agentAutonomy

      return h(
        'div',
        { className: 'mtd-page' },
        h(
          'div',
          { className: 'mtd-scroll' },
          h(
            'div',
            { className: 'mtd-content' },
            h(
              'header',
              { className: 'mtd-head' },
              h('h1', { className: 'mtd-title' }, t('title')),
              h('span', { className: 'mtd-sub' }, t('subtitle')),
              defaultDirectory !== '' ? h('span', { className: 'mtd-dir', title: defaultDirectory }, fill(t('directory'), { directory: defaultDirectory })) : null,
            ),
            error !== '' && downloads.error === '' ? h('div', { className: 'mtd-banner', role: 'alert' }, error) : null,
            downloads.error !== '' ? h('div', { className: 'mtd-banner', role: 'alert' }, fill(t('error.request'), { message: downloads.error })) : null,
            h(
              'form',
              { className: 'mtd-card mtd-form', onSubmit: submit },
              h('input', {
                className: 'mtd-input mtd-grow',
                type: 'url',
                required: true,
                value: url,
                placeholder: t('form.urlPlaceholder'),
                'aria-label': t('form.url'),
                onChange: (event) => setUrl(event.target.value),
              }),
              h('input', {
                className: 'mtd-input mtd-dirinput',
                type: 'text',
                value: directory,
                placeholder: fill(t('form.directoryPlaceholder'), { directory: defaultDirectory }),
                'aria-label': t('form.directory'),
                onChange: (event) => setDirectory(event.target.value),
              }),
              typeof onBrowse === 'function'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'mtd-btn',
                      disabled: picking,
                      title: t('form.browseTitle'),
                      onClick: browse,
                    },
                    picking ? '…' : t('form.browse'),
                  )
                : null,
              h(
                'select',
                {
                  className: 'mtd-input mtd-select',
                  value: threads,
                  'aria-label': t('form.threads'),
                  onChange: (event) => setThreads(event.target.value),
                },
                ['1', '2', '4', '8', '16'].map((value) =>
                  h('option', { key: value, value }, `${value} ${t('form.threads')}`),
                ),
              ),
              h('button', { className: 'mtd-btn mtd-primary', type: 'submit', disabled: busy || (url.trim() === '' && batch.trim() === '') }, busy ? t('form.submitting') : t('form.submit')),
            ),
            h(
              'details',
              { className: 'mtd-card mtd-advanced' },
              h('summary', null, t('form.advanced')),
              h('label', { className: 'mtd-advanced-label' }, t('form.headers')),
              h('textarea', {
                className: 'mtd-input mtd-advanced-text',
                rows: 3,
                value: headersText,
                placeholder: t('form.headersPlaceholder'),
                onChange: (event) => setHeadersText(event.target.value),
              }),
              h('label', { className: 'mtd-advanced-label' }, t('form.sha256')),
              h('input', {
                className: 'mtd-input',
                type: 'text',
                value: sha256,
                placeholder: 'e3b0c442...',
                onChange: (event) => setSha256(event.target.value),
              }),
              h('label', { className: 'mtd-advanced-label' }, t('form.batch')),
              h('textarea', {
                className: 'mtd-input mtd-advanced-text',
                rows: 3,
                value: batch,
                placeholder: t('form.batchPlaceholder'),
                onChange: (event) => setBatch(event.target.value),
              }),
            ),
            h(
              'div',
              { className: 'mtd-settings' },
              h(
                'div',
                { className: 'mtd-setting-row' },
                h(
                  'label',
                  { className: 'mtd-switch-row' },
                  h(Toggle, {
                    checked: silentEnabled,
                    disabled: settingsLocked,
                    label: t('settings.threshold'),
                    onChange: (next) => {
                      setSilentEnabled(next)
                      void saveFlags({ silentEnabled: next })
                    },
                  }),
                  h('span', null, t('settings.threshold')),
                ),
                h('input', {
                  id: 'mtd-threshold',
                  className: 'mtd-input mtd-threshold',
                  type: 'text',
                  inputMode: 'decimal',
                  disabled: settingsLocked || !silentEnabled,
                  value: threshold,
                  'aria-label': t('settings.threshold'),
                  onChange: (event) => setThreshold(event.target.value),
                  onBlur: saveThreshold,
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    void saveThreshold()
                    event.currentTarget.blur()
                  },
                }),
                h(
                  'select',
                  {
                    className: 'mtd-input mtd-unit',
                    disabled: settingsLocked || !silentEnabled,
                    value: thresholdUnit,
                    'aria-label': t('settings.unit'),
                    onChange: (event) => switchThresholdUnit(event.target.value),
                  },
                  h('option', { value: 'KB' }, 'KB'),
                  h('option', { value: 'MB' }, 'MB'),
                  h('option', { value: 'GB' }, 'GB'),
                ),
                h('span', { className: 'mtd-setting-hint' }, silentEnabled ? t('settings.thresholdHint') : t('settings.thresholdOffHint')),
              ),
              h(
                'div',
                { className: 'mtd-setting-row' },
                h(
                  'label',
                  { className: 'mtd-switch-row' },
                  h(Toggle, {
                    checked: minThreadEnabled,
                    disabled: settingsLocked,
                    label: t('settings.minThread'),
                    onChange: (next) => {
                      setMinThreadEnabled(next)
                      void saveFlags({ minThreadEnabled: next })
                    },
                  }),
                  h('span', null, t('settings.minThread')),
                ),
                h('input', {
                  id: 'mtd-minthread',
                  className: 'mtd-input mtd-threshold',
                  type: 'text',
                  inputMode: 'numeric',
                  disabled: settingsLocked || !minThreadEnabled,
                  value: minThread,
                  'aria-label': t('settings.minThread'),
                  onChange: (event) => setMinThread(event.target.value),
                  onBlur: saveMinThread,
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    void saveMinThread()
                    event.currentTarget.blur()
                  },
                }),
                h(
                  'select',
                  {
                    className: 'mtd-input mtd-unit',
                    disabled: settingsLocked || !minThreadEnabled,
                    value: minThreadUnit,
                    'aria-label': t('settings.unit'),
                    onChange: (event) => switchMinThreadUnit(event.target.value),
                  },
                  h('option', { value: 'KB' }, 'KB'),
                  h('option', { value: 'MB' }, 'MB'),
                ),
                h('span', { className: 'mtd-setting-hint' }, minThreadEnabled ? t('settings.minThreadHint') : t('settings.minThreadOffHint')),
              ),
              h(
                'div',
                { className: 'mtd-setting-row' },
                h(
                  'label',
                  { className: 'mtd-switch-row' },
                  h(Toggle, {
                    checked: agentAutonomy,
                    disabled: false,
                    label: t('settings.agentAutonomy'),
                    onChange: (next) => {
                      setAgentAutonomy(next)
                      void saveFlags({ agentAutonomy: next })
                    },
                  }),
                  h('span', null, t('settings.agentAutonomy')),
                ),
                h('span', { className: 'mtd-setting-hint' }, agentAutonomy ? t('settings.agentOnHint') : t('settings.agentOffHint')),
              ),
              h(
                'div',
                { className: 'mtd-setting-row' },
                h('span', { className: 'mtd-setting-label' }, t('settings.rate')),
                h('input', {
                  id: 'mtd-rate',
                  className: 'mtd-input mtd-threshold',
                  type: 'text',
                  inputMode: 'numeric',
                  value: rate,
                  'aria-label': t('settings.rate'),
                  onChange: (event) => setRate(event.target.value),
                  onBlur: saveRate,
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    void saveRate()
                    event.currentTarget.blur()
                  },
                }),
                h('span', { className: 'mtd-setting-hint' }, t('settings.rateHint')),
              ),
              h(
                'div',
                { className: 'mtd-setting-row' },
                h('span', { className: 'mtd-setting-label' }, t('settings.concurrency')),
                h(
                  'select',
                  {
                    className: 'mtd-input mtd-select',
                    value: concurrency,
                    'aria-label': t('settings.concurrency'),
                    onChange: (event) => void saveConcurrency(event.target.value),
                  },
                  ['1', '2', '3', '4', '5', '6', '7', '8'].map((value) => h('option', { key: value, value }, value)),
                ),
                h('span', { className: 'mtd-setting-hint' }, t('settings.concurrencyHint')),
              ),
            ),
            h(
              'div',
              { className: 'mtd-stats' },
              h('span', null, `${t('stats.active')} `, h('b', null, String(active))),
              h('span', null, `${t('stats.finished')} `, h('b', null, String(finished))),
              h('span', null, `${t('stats.speed')} `, h('b', null, formatSpeed(speed))),
              h('span', null, `${t('stats.tasks')} `, h('b', null, String(tasks.length))),
            ),
            tasks.length === 0
              ? h(
                  'div',
                  { className: 'mtd-card mtd-empty' },
                  h('div', { className: 'mtd-empty-title' }, downloads.loading ? '…' : t('empty.title')),
                  downloads.loading ? null : h('div', { className: 'mtd-empty-hint' }, t('empty.hint')),
                )
              : h(
                  'div',
                  { className: 'mtd-list' },
                  tasks.map((task) => h(TaskRow, { key: task.id, task, t, onControl: control, busy, thresholdBytes })),
                ),
          ),
        ),
        pickerOpen && typeof onBrowse === 'function'
          ? h(DirectoryPicker, {
              t,
              initialPath: directory.trim() !== '' ? directory.trim() : undefined,
              browse: onBrowse,
              onSelect: (path) => {
                setDirectory(path)
                setPickerOpen(false)
              },
              onCancel: () => setPickerOpen(false),
            })
          : null,
      )
    }

    /** 多任务时把一条进度条按任务大小裁成多段，各自填充，旁边显示聚合百分比。 */
    const DOCK_MAX_SEGMENTS = 8

    function dockSegments(tasks) {
      const items = tasks.map((task) => ({
        ...task,
        weight: task.totalBytes > 0 ? task.totalBytes : 1,
      }))
      if (items.length <= DOCK_MAX_SEGMENTS) return items
      const head = items.slice(0, DOCK_MAX_SEGMENTS - 1)
      const rest = items.slice(DOCK_MAX_SEGMENTS - 1)
      const weight = rest.reduce((sum, item) => sum + item.weight, 0)
      const received = rest.reduce(
        (sum, item) => sum + (item.totalBytes > 0 ? item.receivedBytes : item.progress * item.weight),
        0,
      )
      head.push({ id: '__rest', filename: '', weight, progress: weight > 0 ? received / weight : 0, rest: rest.length })
      return head
    }

    /** 宽箭头：收起/展开进度条共用。 */
    function DockChevron({ up }) {
      return h(
        'svg',
        {
          className: 'mtd-chevron',
          width: 18,
          height: 9,
          viewBox: '0 0 24 12',
          fill: 'none',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', {
          d: up ? 'M2 10 L12 2 L22 10' : 'M2 2 L12 10 L22 2',
          stroke: 'currentColor',
          strokeWidth: 2.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** 收起后的窄条：宽箭头 + 任务数，点击重新展开。 */
    function DockRestore({ t, count, percent, onShow }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'mtd-dock-restore',
          onClick: onShow,
          title: t('dock.show'),
          'aria-label': t('dock.show'),
        },
        h(DockChevron, { up: true }),
        h('span', null, `${fill(t('dock.tasks'), { count })} · ${percent}%`),
      )
    }

    /** 对话输入框上方的常驻进度条：有未完成任务时出现，点击打开下载面板，右侧可收起。 */
    function DownloadDock({ t, onOpen }) {
      const summary = useSummary()
      const [hidden, setHidden] = React.useState(false)
      const tasks = summary.tasks.length > 0 ? summary.tasks : summary.top === null ? [] : [summary.top]

      React.useEffect(() => {
        if (summary.unfinished === 0) setHidden(false)
      }, [summary.unfinished])

      if (summary.unfinished <= 0 || tasks.length === 0) return null

      const total = summary.totalBytes
      const pct = total > 0
        ? Math.min(1, summary.receivedBytes / total)
        : tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length

      if (hidden) {
        return h(DockRestore, {
          t,
          count: summary.unfinished,
          percent: Math.round(pct * 100),
          onShow: () => setHidden(false),
        })
      }

      const name = tasks.length > 1
        ? fill(t('dock.tasks'), { count: summary.unfinished })
        : tasks[0].filename !== ''
          ? tasks[0].filename
          : tasks[0].url
      const size = formatBytePair(summary.receivedBytes, summary.totalBytes)
      const meta = `${size} · ${Math.round(pct * 100)}%${summary.speed > 0 ? ` · ${formatSpeed(summary.speed)}` : ''}`
      const segments = dockSegments(tasks)

      return h(
        'div',
        { className: 'mtd-dock' },
        h(
          'button',
          {
            type: 'button',
            className: 'mtd-dock-main',
            onClick: onOpen,
            title: t('dock.open'),
            'aria-label': `${t('dock.open')}: ${name} ${meta}`,
          },
          h(
            'span',
            { className: 'mtd-dock-row' },
            h('span', { className: 'mtd-dock-name' }, name),
            h('span', { className: 'mtd-dock-meta' }, meta),
          ),
          h(
            'span',
            { className: 'mtd-dock-bar' },
            segments.map((segment) =>
              h(
                'span',
                {
                  key: segment.id,
                  className: 'mtd-dock-seg',
                  style: { flexGrow: segment.weight, flexBasis: 0 },
                  title: segment.rest !== undefined
                    ? fill(t('dock.rest'), { count: segment.rest })
                    : `${segment.filename} ${Math.round(segment.progress * 100)}%`,
                },
                h('span', {
                  className: 'mtd-dock-seg-fill',
                  style: { width: `${Math.max(0, Math.min(100, segment.progress * 100))}%` },
                }),
              ),
            ),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'mtd-dock-hide',
            onClick: () => setHidden(true),
            title: t('dock.hide'),
            'aria-label': t('dock.hide'),
          },
          h(DockChevron, { up: false }),
        ),
      )
    }

    function PanelIcon({ size, active, t }) {
      const edge = typeof size === 'number' && size > 0 ? size : 20
      const count = useSummary().unfinished
      const nodeRef = React.useRef(null)
      // row：钉子侧边栏行右端；corner：行定位不可用时退回图标角标，保证数字不会消失。
      const [placement, setPlacement] = React.useState('row')
      const label = count > 0 ? fill(t('badge.unfinished'), { count }) : t('title')

      React.useEffect(() => {
        if (count <= 0) return undefined
        const node = nodeRef.current
        if (node === null || node === undefined || typeof node.closest !== 'function') return undefined

        const measure = () => {
          const row = node.closest('button')
          if (row === null) {
            setPlacement('corner')
            return
          }
          let positioned = false
          try {
            positioned = typeof window.getComputedStyle === 'function' && window.getComputedStyle(row).position !== 'static'
          } catch {
            positioned = false
          }
          setPlacement(positioned && row.clientWidth >= 120 ? 'row' : 'corner')
        }

        measure()
        const row = node.closest('button')
        let observer
        if (row !== null && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(row)
        }
        return () => {
          if (observer !== undefined) observer.disconnect()
        }
      }, [count])

      const corner = placement === 'corner'

      return h(
        'span',
        {
          ref: nodeRef,
          className: `mtd-icon${corner ? ' mtd-icon-corner' : ''}`,
          style: { width: edge, height: edge },
          role: 'img',
          'aria-label': label,
          title: label,
        },
        h(
          'svg',
          {
            width: edge,
            height: edge,
            viewBox: '0 0 64 64',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 5 : 4.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { display: 'block', opacity: active ? 1 : 0.85 },
          },
          h('path', { d: 'M32 13v25' }),
          h('path', { d: 'M21 29l11 11 11-11' }),
          h('path', { d: 'M16 45v4a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3v-4' }),
        ),
        count > 0
          ? h(
              'span',
              { className: `mtd-badge${corner ? ' mtd-badge-corner' : ''}`, 'aria-hidden': true },
              count > 9 ? '9+' : String(count),
            )
          : null,
      )
    }

    return {
      name: 'dsh-multithread-downloader',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'multithread-downloader'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'multithread-downloader: styles')

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'multithread-downloader: dictionaries')

        const t = ctx.locale.bind(NS)
        const browse = async (path) => call(`${API}/browse`, { path: path ?? '' })
        const Plugin = () => h(DownloaderPanel, { t, defaults: { threads: 4 }, onBrowse: browse })

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'multithread-downloader', locale: NS }, Plugin),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'multithread-downloader', order: 12, label: () => t('title'), locale: NS },
            (props) => h(PanelIcon, { size: props.size, active: props.active, t }),
          ),
        )

        const openPanel = () => {
          const layout = ctx.get('layout')
          if (layout !== null && layout !== undefined && typeof layout.selectPanel === 'function') {
            layout.selectPanel('multithread-downloader')
          }
        }
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'multithread-downloader-dock',
              order: 20,
              label: () => t('dock.open'),
              locale: NS,
            },
            () => h(DownloadDock, { t, onOpen: openPanel }),
          ),
        )
      },
    }
  },
})
