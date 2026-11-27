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
      'form.checksum': '校验值（可选，十六进制）',
      'form.checksumAlgorithm': '校验算法',
      'form.checksumValue': '校验值',
      'form.batch': '批量 URL（每行一个，最多 20 个；填写后忽略上方地址）',
      'form.batchPlaceholder': 'https://example.com/a.zip\nhttps://example.com/b.zip',
      'form.batchTooMany': '一次最多批量添加 20 个地址',
      'form.submit': '开始下载',
      'form.submitting': '正在创建…',
      'stats.active': '进行中',
      'stats.finished': '已完成',
      'stats.speed': '总速度',
      'stats.eta': '预计剩余',
      'stats.tasks': '任务',
      'stats.connections': '连接',
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
      'task.eta': '约剩 {eta}',
      'task.unknownSize': '大小未知',
      'chart.title': '大文件速度曲线',
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
      'settings.concurrency': '并发限制数',
      'settings.concurrencyHint': '并发上限 = 并发任务数 × 单任务线程数，默认 16（1–64）；Agent 指定的线程数同样受此约束，不可绕过',
      'settings.loadAdaptive': '设备负载自适应',
      'settings.loadAdaptiveHint': '每 2 秒采样 CPU 与内存：压力高时立即收缩连接预算，资源充裕后逐步恢复到设定值',
      'settings.loadAdaptiveOffHint': '已关闭：始终按设定值分配连接，不看设备负载',
      'settings.siteAdaptive': '站点风控自适应',
      'settings.siteAdaptiveHint': '同一网站（含子域）返回 403/429/503 时降低该站并发并叠加站点限速，冷却后逐步恢复；不同网站各自独立',
      'settings.siteAdaptiveOffHint': '已关闭：被拒站点按普通失败重试，不做降档',
      'stats.load': '负载',
      'stats.effective': '有效并发',
      'site.title': '站点限速',
      'site.connections': '{count} 连接',
      'site.cooldown': '冷却 {seconds}s',
      'site.note': 'HTTP {status} 触发风控 · 第 {signals} 次',
      'task.risk': '站点限速 L{level} · {connections} 连接 · {rate}/s',
      'load.level.normal': '正常',
      'load.level.elevated': '偏高',
      'load.level.high': '高',
      'load.level.critical': '紧张',
      'settings.agentOnHint': '已开启：阈值设置已屏蔽（仍约束 Agent 任务）；手动下载始终多线程并显示',
      'settings.doh': 'DoH 解析',
      'settings.dohHint': '通过 HTTPS 查询 DNS，绕过被污染的本地 DNS；失败时回退系统 DNS',
      'settings.dohProvider': 'DoH 提供商',
      'settings.dohRiskTitle': '启用 DoH 解析？',
      'settings.dohRiskText': 'DoH 会把域名查询发送给你选择的第三方解析服务，并可能改变下载连接的实际目标。解析失败时会回退系统 DNS。请确认你信任该提供商后再启用。',
      'settings.dohRiskConfirm': '确认启用',
      'settings.github': 'GitHub 模式',
      'settings.githubHint': '把 GitHub Release 直链换成 API 资产链接，绕过 github.com DNS 污染',
      'settings.cancel': '取消',
      'settings.agentOffHint': '已关闭：面板参数可调',
      'settings.invalid': '请输入 1 KB – 10 GB 之间的数值',
      'settings.minThread': '单线程阈值',
      'settings.minThreadHint': '仅约束 Agent 任务：小于该值时不分片、单连接下载',
      'settings.minThreadInvalid': '请输入 0 – 10 GB 之间的数值',
      'settings.unit': '单位',
      'settings.minThreadEnabled': '启用单线程阈值',
      'settings.autoThreads': '自动分片数',
      'settings.autoThreadsHint': '按大小自动选 4/6/8 条连接，每条连接被限速时运行中自动加连接（最多 8 条）；显式指定线程数时以指定值为准',
      'settings.autoThreadsOffHint': '已关闭：统一使用面板上的线程数',
      'settings.fingerprintResume': '续传指纹校验',
      'settings.fingerprintResumeHint': '续传前与收尾核对 ETag/Last-Modified，分片请求带 If-Range；远端换版本会自动从头重下',
      'settings.fingerprintResumeOffHint': '已关闭：只按文件大小判断，远端换版本可能拼出混合文件',
      'settings.stallWatchdog': '停滞看门狗',
      'settings.stallWatchdogHint': '连接半死却还在涓流（几 B/s）时，按窗口吞吐判定停滞并换一组连接；两次仍极慢就标记「远端极慢」，继续下而不判失败',
      'settings.stallWatchdogOffHint': '已关闭：只靠 30 秒正文空闲超时，涓流连接会一直挂着',
      'settings.agentAutonomy': 'Agent 自主模式',
      'settings.agentAutonomyHint': '开启后阈值设置屏蔽但继续约束 Agent 任务；面板手动下载不受限制',
      'settings.title': '设置',
      'settings.summary': '并发 {connections} · {rate} · 静默 {threshold} · {doh}',
      'settings.rateValue': '{kb} KB/s',
      'settings.unlimited': '不限速',
      'settings.silentOff': '静默关',
      'settings.dohOn': 'DoH 开',
      'settings.dohOff': 'DoH 关',
      'settings.group.connection': '连接与带宽',
      'settings.group.download': '下载与续传',
      'settings.group.agent': 'Agent 与阈值',
      'settings.group.network': '网络与站点',
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
      'form.checksum': 'Checksum (optional, hex)',
      'form.checksumAlgorithm': 'Checksum algorithm',
      'form.checksumValue': 'Checksum value',
      'form.batch': 'Batch URLs, one per line, max 20; overrides the URL above',
      'form.batchPlaceholder': 'https://example.com/a.zip\nhttps://example.com/b.zip',
      'form.batchTooMany': '一次最多批量添加 20 个地址',
      'form.submit': 'Start download',
      'form.submitting': 'Creating…',
      'stats.active': 'Active',
      'stats.finished': 'Completed',
      'stats.speed': 'Total speed',
      'stats.eta': 'ETA',
      'stats.tasks': 'Tasks',
      'stats.connections': 'Connections',
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
      'task.eta': 'ETA {eta}',
      'task.unknownSize': 'Unknown size',
      'chart.title': 'Large-file speed',
      'chart.window': 'Last {seconds}s',
      'chart.eta': 'ETA {eta}',
      'chart.average': 'Avg {speed}',
      'chart.waiting': 'Sampling…',
      'settings.threshold': 'Silent download threshold',
      'settings.thresholdUnit': 'MB',
      'settings.thresholdHint': 'Applies to agent tasks only: below this size they stay out of the panel and conversation strip',
      'settings.thresholdOffHint': 'Off: every task is shown',
      'settings.minThreadOffHint': 'Off: every task splits across threads',
      'settings.rate': 'Global rate limit (KB/s, 0 = unlimited)',
      'settings.rateHint': 'Shared by all downloads',
      'settings.concurrency': 'Connection limit',
      'settings.concurrencyHint': 'Cap = concurrent tasks × threads per task; default 16 (1–64). Threads an agent specifies are bound by the same cap',
      'settings.loadAdaptive': 'Device load adaptation',
      'settings.loadAdaptiveHint': 'Samples CPU and memory every 2s: shrinks the connection budget at once under pressure and recovers it gradually',
      'settings.loadAdaptiveOffHint': 'Off: the configured limit is always used, regardless of device load',
      'settings.siteAdaptive': 'Site risk-control adaptation',
      'settings.siteAdaptiveHint': 'On 403/429/503 from one site (subdomains included) it lowers that site\'s connections and adds a site-wide rate limit, then recovers gradually; other sites are unaffected',
      'settings.siteAdaptiveOffHint': 'Off: rejected sites are retried like ordinary failures, with no throttle step-down',
      'stats.load': 'Load',
      'stats.effective': 'Effective conns',
      'site.title': 'Throttled sites',
      'site.connections': '{count} conns',
      'site.cooldown': 'cooling {seconds}s',
      'site.note': 'risk control on HTTP {status} · signal {signals}',
      'task.risk': 'Site throttled L{level} · {connections} conns · {rate}/s',
      'load.level.normal': 'normal',
      'load.level.elevated': 'elevated',
      'load.level.high': 'high',
      'load.level.critical': 'critical',
      'settings.agentOnHint': 'On: thresholds are masked but still govern agent tasks; manual downloads stay multi-threaded and visible',
      'settings.doh': 'DoH resolution',
      'settings.dohHint': 'Resolve DNS over HTTPS to bypass local poisoning; falls back to system DNS on failure',
      'settings.dohProvider': 'DoH provider',
      'settings.dohRiskTitle': 'Enable DoH resolution?',
      'settings.dohRiskText': 'DoH sends DNS queries to the selected third-party resolver and may change the actual download target. It falls back to system DNS when resolution fails. Enable only if you trust this provider.',
      'settings.dohRiskConfirm': 'Enable',
      'settings.github': 'GitHub mode',
      'settings.githubHint': 'Rewrite GitHub Release links to API asset URLs to bypass github.com DNS poisoning',
      'settings.cancel': 'Cancel',
      'settings.agentOffHint': 'Off: panel controls apply',
      'settings.invalid': 'Enter a value between 1 KB and 10 GB',
      'settings.minThread': 'Single-connection threshold',
      'settings.minThreadHint': 'Applies to agent tasks only: below this size they use one connection',
      'settings.minThreadInvalid': 'Enter a value between 0 and 10 GB',
      'settings.unit': 'Unit',
      'settings.minThreadEnabled': 'Enable single-connection threshold',
      'settings.autoThreads': 'Automatic thread count',
      'settings.autoThreadsHint': 'Picks 4/6/8 connections by size and climbs while every connection stays rate-limited (up to 8); an explicit threads value still wins',
      'settings.autoThreadsOffHint': 'Off: always use the panel thread count',
      'settings.fingerprintResume': 'Resume fingerprint check',
      'settings.fingerprintResumeHint': 'Checks ETag/Last-Modified before resuming and at the end; chunk requests carry If-Range, and a changed remote file restarts the download',
      'settings.fingerprintResumeOffHint': 'Off: only the file size is compared, so a changed remote file can mix versions',
      'settings.stallWatchdog': 'Stall watchdog',
      'settings.stallWatchdogHint': 'When a connection is half-dead but still trickling a few bytes per second, the watchdog judges the window throughput, swaps in a fresh connection, and after two failed attempts marks the task "remote too slow" instead of failing it',
      'settings.stallWatchdogOffHint': 'Off: only the 30s body idle timeout remains, so a trickling connection stays stuck',
      'settings.agentAutonomy': 'Agent autonomy',
      'settings.agentAutonomyHint': 'Threshold settings are masked but still govern agent tasks; manual panel downloads are unrestricted',
      'settings.title': 'Settings',
      'settings.summary': '{connections} connections · {rate} · silent {threshold} · {doh}',
      'settings.rateValue': '{kb} KB/s',
      'settings.unlimited': 'unlimited',
      'settings.silentOff': 'silent off',
      'settings.dohOn': 'DoH on',
      'settings.dohOff': 'DoH off',
      'settings.group.connection': 'Connections & bandwidth',
      'settings.group.download': 'Download & resume',
      'settings.group.agent': 'Agent & thresholds',
      'settings.group.network': 'Network & sites',
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
.mtd-settings { padding: 0; margin: 0 0 14px; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow: hidden; }
.mtd-settings-head { display: flex; align-items: center; gap: 8px; padding: 11px 16px; cursor: pointer; list-style: none; }
.mtd-settings-head::-webkit-details-marker { display: none; }
.mtd-settings[open] > .mtd-settings-head { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mtd-settings-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.mtd-settings-chevron { display: inline-flex; flex: none; color: var(--dsw-alias-label-secondary); transition: transform .15s ease; }
.mtd-settings[open] .mtd-settings-chevron { transform: rotate(90deg); }
.mtd-settings-title { flex: none; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.mtd-settings-summary { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-variant-numeric: tabular-nums; }
.mtd-settings-body { display: flex; flex-direction: column; gap: 16px; padding: 14px 16px 16px; }
.mtd-setting-group { display: flex; flex-direction: column; gap: 7px; }
.mtd-setting-group + .mtd-setting-group { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 14px; }
.mtd-setting-group-title { margin: 0 0 2px; font-size: 11.5px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); }
.mtd-setting-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.mtd-setting-hint { flex: 1 1 100%; min-width: 0; opacity: .8; font-size: 11px; }
.mtd-unit { flex: none; padding: 4px 6px; }
.mtd-threshold { width: 76px; flex: none; padding: 4px 8px; }
.mtd-setting-unit { flex: none; }
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
.mtd-task-note { margin-top: 8px; opacity: .75; font-size: 11.5px; overflow-wrap: anywhere; }
.mtd-sites { margin: 0 0 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.mtd-sites-title { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mtd-site-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; font-variant-numeric: tabular-nums; }
.mtd-site-key { font-weight: 600; overflow-wrap: anywhere; }
.mtd-site-note { opacity: .7; font-size: 11.5px; }
.mtd-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; background: color-mix(in srgb, #000 35%, transparent); }
.mtd-modal-card { display: flex; flex-direction: column; width: min(560px, 100%); max-height: min(70vh, 600px); overflow: hidden; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; box-shadow: 0 18px 50px rgba(0, 0, 0, .25); }
.mtd-modal-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mtd-modal-title { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 600; }
.mtd-crumbs { display: flex; gap: 2px; padding: 8px 10px; overflow-x: auto; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mtd-crumb { flex: none; max-width: 160px; padding: 2px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; border-radius: 4px; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; }
.mtd-crumb:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mtd-modal-body { flex: 1 1 auto; min-height: 180px; max-height: 360px; padding: 6px; overflow-y: auto; }
.mtd-dirbtn { display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: 6px; background: none; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.mtd-dirbtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mtd-dirbtn.hidden { opacity: .6; }
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
.mtd-checksum-row { display: flex; gap: 8px; align-items: stretch; }
.mtd-checksum-select { flex: 0 0 110px; }
.mtd-chart-waiting { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.mtd-chart { margin-top: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 8px 10px 6px; }
.mtd-chart-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin-bottom: 4px; }
.mtd-chart-title { font-size: 11.5px; font-weight: 600; }
.mtd-chart-meta, .mtd-chart-eta { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.mtd-chart-eta { margin-left: auto; }
.mtd-chart-plot { position: relative; height: 88px; padding-left: 64px; }
.mtd-chart-speed-label { position: absolute; left: 0; width: 58px; text-align: right; transform: translateY(-50%); color: var(--dsw-alias-label-secondary); font-size: 9px; line-height: 12px; font-variant-numeric: tabular-nums; pointer-events: none; }

.mtd-chart-svg { display: block; width: 100%; height: 100%; }
.mtd-chart-grid { stroke: var(--dsw-alias-label-secondary); stroke-width: 1; stroke-dasharray: 4 4; opacity: .55; vector-effect: non-scaling-stroke; }
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
      const peak = Math.max(1, ...points.map((point) => Math.max(0, Number(point.s) || 0)))
      const unit = peak >= 1024 * 1024 ? 1024 * 1024 : 1024
      const value = peak / unit
      const steps = unit === 1024 * 1024
        ? [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]
        : [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]
      const stepValue = steps.find((candidate) => value / candidate <= 5) ?? 1000
      const step = stepValue * unit
      const maxTick = Math.ceil(peak / step) * step
      const y = (speed) => height - inset - Math.max(0, Math.min(1, speed / maxTick)) * (height - inset * 2)
      const x = (seconds) => (Math.max(0, Math.min(span, seconds)) / span) * width
      const ticks = []
      for (let value = 0; value <= maxTick + step / 2; value += step) ticks.push(value)
      const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)} ${y(Math.max(0, Number(point.s) || 0)).toFixed(1)}`).join(' ')
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
              'aria-label': `${t('chart.title')} ${formatSpeed(last.s || 0)}`,
            },
            h('path', { className: `mtd-chart-area ${task.status}`, d: area }),
            ticks.map((value) =>
              h('line', {
                key: `h-${value}`,
                className: 'mtd-chart-grid',
                x1: 0,
                x2: width,
                y1: y(value),
                y2: y(value),
              }),
            ),
            h('path', { className: `mtd-chart-line ${task.status}`, d: line }),
          ),
          ticks.map((value) =>
            h('span', { key: `tick-${value}`, className: 'mtd-chart-speed-label', style: { top: `${(y(value) / height) * 100}%` } }, formatSpeed(value)),
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
    const EMPTY_SUMMARY = { unfinished: 0, active: 0, totalBytes: 0, receivedBytes: 0, speed: 0, etaSeconds: 0, top: null, tasks: [] }
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
            etaSeconds: Number(data.etaSeconds) || 0,
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
          task.status === 'downloading' && task.etaSeconds !== undefined
            ? h('span', null, fill(t('task.eta'), { eta: formatEta(task.etaSeconds) }))
            : null,
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
        (task.totalBytes >= thresholdBytes || task.forceDisplay === true) && Array.isArray(task.history) && task.history.length > 1
          ? h(ProgressChart, { task, t })
          : (task.totalBytes >= thresholdBytes || task.forceDisplay === true) && task.status === 'downloading'
            ? h('div', { className: 'mtd-chart mtd-chart-waiting' }, t('chart.waiting'))
            : null,
        h('div', { className: 'mtd-url', title: task.path || task.url }, task.path || task.url),
        task.status === 'failed' && task.error !== '' ? h('div', { className: 'mtd-task-error' }, task.error) : null,
        typeof task.stallNote === 'string' && task.stallNote !== ''
          ? h('div', { className: 'mtd-task-note' }, task.stallNote)
          : null,
        task.fingerprint !== undefined && typeof task.fingerprint.note === 'string' && task.fingerprint.note !== ''
          ? h('div', { className: 'mtd-task-note' }, task.fingerprint.note)
          : null,
        typeof task.riskNote === 'string' && task.riskNote !== ''
          ? h('div', { className: 'mtd-task-note' }, task.riskNote)
          : task.siteThrottle !== undefined
            ? h(
                'div',
                { className: 'mtd-task-note' },
                fill(t('task.risk'), {
                  level: task.siteThrottle.level,
                  connections: task.siteThrottle.connections,
                  rate: formatSpeed(task.siteThrottle.rateBytes),
                }),
              )
            : null,
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

    /** 并发限制数（连接数 = 任务数 × 线程数）的候选值，默认 16。 */
    const CONCURRENCY_OPTIONS = ['1', '2', '4', '6', '8', '12', '16', '24', '32', '48', '64']

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
                          className: `mtd-dirbtn${entry.hidden ? ' hidden' : ''}`,
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
      // 用户手动改过线程数后，就不再被 Host 的默认值覆盖。
      const [threadsTouched, setThreadsTouched] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [pickerOpen, setPickerOpen] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      const [threshold, setThreshold] = React.useState('')
      const [thresholdUnit, setThresholdUnit] = React.useState('MB')
      const [minThread, setMinThread] = React.useState('')
      const [minThreadUnit, setMinThreadUnit] = React.useState('MB')
      const [silentEnabled, setSilentEnabled] = React.useState(true)
      const [minThreadEnabled, setMinThreadEnabled] = React.useState(true)
      const [autoThreads, setAutoThreads] = React.useState(true)
      const [fingerprintResume, setFingerprintResume] = React.useState(true)
      const [stallWatchdog, setStallWatchdog] = React.useState(true)
      const [agentAutonomy, setAgentAutonomy] = React.useState(false)
      const [dohEnabled, setDohEnabled] = React.useState(false)
      const [dohProvider, setDohProvider] = React.useState('alidns')
      const [dohConfirm, setDohConfirm] = React.useState(false)
      const [githubEnabled, setGithubEnabled] = React.useState(false)
      const [rate, setRate] = React.useState('0')
      const [concurrency, setConcurrency] = React.useState('16')
      const [loadAdaptive, setLoadAdaptive] = React.useState(true)
      const [siteAdaptive, setSiteAdaptive] = React.useState(true)
      const [headersText, setHeadersText] = React.useState('')
      const [checksumAlgorithm, setChecksumAlgorithm] = React.useState('sha256')
      const [checksum, setChecksum] = React.useState('')
      const [batch, setBatch] = React.useState('')
      const downloads = useDownloads((message) => setError(fill(t('error.request'), { message })))

      const meta = downloads.meta
      // 线程默认值以 Host 配置为准（cordis.patch.yml 里可以不是 4）。
      const defaultThreads = meta !== null && Number(meta.defaultThreads) > 0
        ? Math.round(Number(meta.defaultThreads))
        : (Number(defaults.threads) || 4)
      const threadOptions = [...new Set([1, 2, 3, 4, 6, 8, 12, 16, defaultThreads])]
        .sort((left, right) => left - right)
        .map(String)
      React.useEffect(() => {
        if (threadsTouched) return
        setThreads(String(defaultThreads))
      }, [defaultThreads, threadsTouched])
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
        if (meta !== null && meta.autoThreads !== undefined) setAutoThreads(Boolean(meta.autoThreads))
      }, [meta === null ? undefined : meta.autoThreads])
      React.useEffect(() => {
        if (meta !== null && meta.fingerprintResume !== undefined) setFingerprintResume(Boolean(meta.fingerprintResume))
      }, [meta === null ? undefined : meta.fingerprintResume])
      React.useEffect(() => {
        if (meta !== null && meta.stallWatchdog !== undefined) setStallWatchdog(Boolean(meta.stallWatchdog))
      }, [meta === null ? undefined : meta.stallWatchdog])
      React.useEffect(() => {
        if (meta !== null && meta.agentAutonomy !== undefined) setAgentAutonomy(Boolean(meta.agentAutonomy))
      }, [meta === null ? undefined : meta.agentAutonomy])
      React.useEffect(() => {
        if (meta !== null && meta.dohEnabled !== undefined) setDohEnabled(Boolean(meta.dohEnabled))
      }, [meta === null ? undefined : meta.dohEnabled])
      React.useEffect(() => {
        if (meta !== null && meta.dohProvider !== undefined) setDohProvider(meta.dohProvider)
      }, [meta === null ? undefined : meta.dohProvider])
      React.useEffect(() => {
        if (meta !== null && meta.githubEnabled !== undefined) setGithubEnabled(Boolean(meta.githubEnabled))
      }, [meta === null ? undefined : meta.githubEnabled])
      React.useEffect(() => {
        if (meta !== null && meta.loadAdaptive !== undefined) setLoadAdaptive(Boolean(meta.loadAdaptive))
      }, [meta === null ? undefined : meta.loadAdaptive])
      React.useEffect(() => {
        if (meta !== null && meta.siteAdaptive !== undefined) setSiteAdaptive(Boolean(meta.siteAdaptive))
      }, [meta === null ? undefined : meta.siteAdaptive])
      React.useEffect(() => {
        if (meta !== null && meta.rateLimitBytes !== undefined) setRate(String(Math.round(meta.rateLimitBytes / 1024)))
      }, [meta === null ? undefined : meta.rateLimitBytes])
      React.useEffect(() => {
        if (meta === null) return
        const limit = meta.maxConnections !== undefined ? meta.maxConnections : meta.maxConcurrent
        if (limit !== undefined) setConcurrency(String(limit))
      }, [meta === null ? undefined : meta.maxConnections, meta === null ? undefined : meta.maxConcurrent])
      const tasks = downloads.tasks
      const resources = meta !== null && meta.resources !== undefined ? meta.resources : null
      const sites = meta !== null && Array.isArray(meta.sites) ? meta.sites : []
      const effectiveConnections = meta !== null && meta.effectiveConnections !== undefined
        ? meta.effectiveConnections
        : meta !== null && meta.maxConnections !== undefined
          ? meta.maxConnections
          : Number(concurrency) || 0
      const active = tasks.filter((task) => task.status === 'downloading' || task.status === 'probing' || task.status === 'queued').length
      const finished = tasks.filter((task) => task.status === 'completed').length
      const speed = tasks.reduce((sum, task) => sum + (task.status === 'downloading' ? task.speed : 0), 0)
      // 面板整体 ETA：只统计正在下载的任务，大小未知的任务不计入。
      const remainingBytes = tasks.reduce((sum, task) => (
        task.status === 'downloading' && task.totalBytes > 0
          ? sum + Math.max(0, task.totalBytes - task.receivedBytes)
          : sum
      ), 0)
      const etaSeconds = meta !== null && Number(meta.etaSeconds) > 0
        ? Math.round(Number(meta.etaSeconds))
        : speed > 0 && remainingBytes > 0
          ? Math.max(1, Math.round(remainingBytes / speed))
          : 0
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
              checksum: targets.length === 1 && checksum.trim() !== ''
                ? { algorithm: checksumAlgorithm, value: checksum.trim() }
                : undefined,
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
        await saveFlags({ maxConnections: Number(value) })
      }

      const requestDohToggle = (next) => {
        if (next) {
          setDohConfirm(true)
          return
        }
        setDohEnabled(false)
        void saveFlags({ dohEnabled: false })
      }

      const confirmDoh = () => {
        setDohConfirm(false)
        setDohEnabled(true)
        void saveFlags({ dohEnabled: true, dohProvider })
      }

      const changeDohProvider = (next) => {
        setDohProvider(next)
        if (dohEnabled) void saveFlags({ dohProvider: next })
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

      /** 设置分组：一个标题 + 若干设置行，收起时只显示标题与摘要。 */
      const settingGroup = (title, ...rows) => h(
        'section',
        { className: 'mtd-setting-group' },
        h('h3', { className: 'mtd-setting-group-title' }, title),
        ...rows,
      )
      const rateKb = Math.round(Number(rate))
      const settingsSummary = fill(t('settings.summary'), {
        connections: String(effectiveConnections),
        rate: Number.isFinite(rateKb) && rateKb > 0 ? fill(t('settings.rateValue'), { kb: String(rateKb) }) : t('settings.unlimited'),
        threshold: silentEnabled ? `${threshold === '' ? '–' : threshold} ${thresholdUnit}` : t('settings.silentOff'),
        doh: dohEnabled ? t('settings.dohOn') : t('settings.dohOff'),
      })

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
                  onChange: (event) => {
                    setThreadsTouched(true)
                    setThreads(event.target.value)
                  },
                },
                threadOptions.map((value) =>
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
              h('label', { className: 'mtd-advanced-label' }, t('form.checksum')),
              h(
                'div',
                { className: 'mtd-checksum-row' },
                h(
                  'select',
                  {
                    className: 'mtd-input mtd-checksum-select',
                    value: checksumAlgorithm,
                    'aria-label': t('form.checksumAlgorithm'),
                    onChange: (event) => setChecksumAlgorithm(event.target.value),
                  },
                  ['sha256', 'sha512', 'sha1', 'md5', 'crc32'].map((algorithm) =>
                    h('option', { key: algorithm, value: algorithm }, algorithm.toUpperCase()),
                  ),
                ),
                h('input', {
                  className: 'mtd-input',
                  type: 'text',
                  value: checksum,
                  placeholder: {
                    md5: '32 位十六进制',
                    sha1: '40 位十六进制',
                    sha256: '64 位十六进制',
                    sha512: '128 位十六进制',
                    crc32: '8 位十六进制',
                  }[checksumAlgorithm],
                  'aria-label': t('form.checksumValue'),
                  onChange: (event) => setChecksum(event.target.value),
                }),
              ),
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
              'details',
              { className: 'mtd-card mtd-settings' },
              h(
                'summary',
                { className: 'mtd-settings-head' },
                h(
                  'span',
                  { className: 'mtd-settings-chevron', 'aria-hidden': true },
                  h(
                    'svg',
                    { width: 10, height: 10, viewBox: '0 0 12 12', fill: 'none', focusable: 'false' },
                    h('path', {
                      d: 'M4 2 L8 6 L4 10',
                      stroke: 'currentColor',
                      strokeWidth: 1.8,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                    }),
                  ),
                ),
                h('span', { className: 'mtd-settings-title' }, t('settings.title')),
                h('span', { className: 'mtd-settings-summary' }, settingsSummary),
              ),
              h(
                'div',
                { className: 'mtd-settings-body' },
                settingGroup(
                  t('settings.group.connection'),
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
                      [...new Set(CONCURRENCY_OPTIONS.concat(concurrency))].sort((left, right) => Number(left) - Number(right)).map((value) => h('option', { key: value, value }, value)),
                    ),
                    h('span', { className: 'mtd-setting-hint' }, t('settings.concurrencyHint')),
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
                    h(
                      'label',
                      { className: 'mtd-switch-row' },
                      h(Toggle, {
                        checked: loadAdaptive,
                        label: t('settings.loadAdaptive'),
                        onChange: (next) => {
                          setLoadAdaptive(next)
                          void saveFlags({ loadAdaptive: next })
                        },
                      }),
                      h('span', null, t('settings.loadAdaptive')),
                    ),
                    h('span', { className: 'mtd-setting-hint' }, loadAdaptive ? t('settings.loadAdaptiveHint') : t('settings.loadAdaptiveOffHint')),
                  ),
                ),
                settingGroup(
                  t('settings.group.download'),
                  h(
                    'div',
                    { className: 'mtd-setting-row' },
                    h(
                      'label',
                      { className: 'mtd-switch-row' },
                      h(Toggle, {
                        checked: autoThreads,
                        label: t('settings.autoThreads'),
                        onChange: (next) => {
                          setAutoThreads(next)
                          void saveFlags({ autoThreads: next })
                        },
                      }),
                      h('span', null, t('settings.autoThreads')),
                    ),
                    h('span', { className: 'mtd-setting-hint' }, autoThreads ? t('settings.autoThreadsHint') : t('settings.autoThreadsOffHint')),
                  ),
                  h(
                    'div',
                    { className: 'mtd-setting-row' },
                    h(
                      'label',
                      { className: 'mtd-switch-row' },
                      h(Toggle, {
                        checked: fingerprintResume,
                        label: t('settings.fingerprintResume'),
                        onChange: (next) => {
                          setFingerprintResume(next)
                          void saveFlags({ fingerprintResume: next })
                        },
                      }),
                      h('span', null, t('settings.fingerprintResume')),
                    ),
                    h('span', { className: 'mtd-setting-hint' }, fingerprintResume ? t('settings.fingerprintResumeHint') : t('settings.fingerprintResumeOffHint')),
                  ),
                  h(
                    'div',
                    { className: 'mtd-setting-row' },
                    h(
                      'label',
                      { className: 'mtd-switch-row' },
                      h(Toggle, {
                        checked: stallWatchdog,
                        label: t('settings.stallWatchdog'),
                        onChange: (next) => {
                          setStallWatchdog(next)
                          void saveFlags({ stallWatchdog: next })
                        },
                      }),
                      h('span', null, t('settings.stallWatchdog')),
                    ),
                    h('span', { className: 'mtd-setting-hint' }, stallWatchdog ? t('settings.stallWatchdogHint') : t('settings.stallWatchdogOffHint')),
                  ),
                ),
                settingGroup(
                  t('settings.group.agent'),
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
                ),
                settingGroup(
                  t('settings.group.network'),
                  h(
                    'div',
                    { className: 'mtd-setting-row' },
                    h(
                      'label',
                      { className: 'mtd-switch-row' },
                      h(Toggle, {
                        checked: siteAdaptive,
                        label: t('settings.siteAdaptive'),
                        onChange: (next) => {
                          setSiteAdaptive(next)
                          void saveFlags({ siteAdaptive: next })
                        },
                      }),
                      h('span', null, t('settings.siteAdaptive')),
                    ),
                    h('span', { className: 'mtd-setting-hint' }, siteAdaptive ? t('settings.siteAdaptiveHint') : t('settings.siteAdaptiveOffHint')),
                  ),
                  h(
                    'div',
                    { className: 'mtd-setting-row' },
                    h(
                      'label',
                      { className: 'mtd-switch-row' },
                      h(Toggle, {
                        checked: dohEnabled,
                        label: t('settings.doh'),
                        onChange: requestDohToggle,
                      }),
                      h('span', null, t('settings.doh')),
                    ),
                    h(
                      'select',
                      {
                        className: 'mtd-input mtd-select',
                        value: dohProvider,
                        disabled: !dohEnabled,
                        'aria-label': t('settings.dohProvider'),
                        onChange: (event) => changeDohProvider(event.target.value),
                      },
                      h('option', { value: 'cloudflare' }, 'Cloudflare'),
                      h('option', { value: 'alidns' }, 'AliDNS'),
                      h('option', { value: 'tencent' }, 'Tencent'),
                    ),
                    h('span', { className: 'mtd-setting-hint' }, t('settings.dohHint')),
                  ),
                  h(
                    'div',
                    { className: 'mtd-setting-row' },
                    h(
                      'label',
                      { className: 'mtd-switch-row' },
                      h(Toggle, {
                        checked: githubEnabled,
                        label: t('settings.github'),
                        onChange: (next) => {
                          setGithubEnabled(next)
                          void saveFlags({ githubEnabled: next })
                        },
                      }),
                      h('span', null, t('settings.github')),
                    ),
                    h('span', { className: 'mtd-setting-hint' }, t('settings.githubHint')),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'mtd-stats' },
              h('span', null, `${t('stats.active')} `, h('b', null, String(active))),
              h('span', null, `${t('stats.finished')} `, h('b', null, String(finished))),
              h('span', null, `${t('stats.speed')} `, h('b', null, formatSpeed(speed))),
              etaSeconds > 0 ? h('span', null, `${t('stats.eta')} `, h('b', null, formatEta(etaSeconds))) : null,
              h('span', null, `${t('stats.tasks')} `, h('b', null, String(tasks.length))),
              h('span', null, `${t('stats.connections')} `, h('b', null, `${meta === null || meta.activeConnections === undefined ? 0 : meta.activeConnections}/${effectiveConnections}`)),
              resources === null
                ? null
                : h(
                    'span',
                    { title: t('stats.effective') },
                    `${t('stats.load')} `,
                    h(
                      'b',
                      null,
                      [
                        resources.cpuPct === null || resources.cpuPct === undefined ? 'CPU –' : `CPU ${resources.cpuPct}%`,
                        resources.memoryPct === null || resources.memoryPct === undefined ? null : `内存 ${resources.memoryPct}%`,
                        resources.enabled === false ? null : t(`load.level.${resources.level ?? 'normal'}`),
                      ].filter(Boolean).join(' · '),
                    ),
                  ),
            ),
            sites.length === 0
              ? null
              : h(
                  'div',
                  { className: 'mtd-card mtd-sites' },
                  h('div', { className: 'mtd-sites-title' }, t('site.title')),
                  sites.map((site) => {
                    const cooldown = Math.max(0, Math.ceil(((site.cooldownUntil ?? 0) - Date.now()) / 1000))
                    return h(
                      'div',
                      { className: 'mtd-site-row', key: site.key },
                      h('span', { className: 'mtd-site-key' }, site.key),
                      h('span', { className: `mtd-chip ${cooldown > 0 ? 'paused' : 'downloading'}` }, `L${site.level}`),
                      h('span', null, fill(t('site.connections'), { count: site.connections })),
                      site.rateBytes > 0 ? h('span', null, formatSpeed(site.rateBytes)) : null,
                      cooldown > 0 ? h('span', null, fill(t('site.cooldown'), { seconds: cooldown })) : null,
                      h('span', { className: 'mtd-site-note' }, fill(t('site.note'), { status: site.lastStatus, signals: site.signals })),
                    )
                  }),
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
        dohConfirm
          ? h(
              'div',
              { className: 'mtd-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('settings.dohRiskTitle') },
              h(
                'div',
                { className: 'mtd-modal-card' },
                h('div', { className: 'mtd-modal-head' }, h('span', { className: 'mtd-modal-title' }, t('settings.dohRiskTitle'))),
                h('div', { className: 'mtd-modal-body' }, h('div', { className: 'mtd-modal-note' }, t('settings.dohRiskText'))),
                h(
                  'div',
                  { className: 'mtd-modal-foot' },
                  h('span', { className: 'mtd-modal-path' }),
                  h('button', { type: 'button', className: 'mtd-btn', onClick: () => setDohConfirm(false) }, t('settings.cancel')),
                  h('button', { type: 'button', className: 'mtd-btn mtd-primary', onClick: confirmDoh }, t('settings.dohRiskConfirm')),
                ),
              ),
            )
          : null,
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

    /** 收起后的窄条：宽箭头 + 任务数 + 预估剩余，点击重新展开。 */
    function DockRestore({ t, count, percent, etaSeconds, onShow }) {
      const label = `${fill(t('dock.tasks'), { count })} · ${percent}%${etaSeconds > 0 ? ` · ${fill(t('task.eta'), { eta: formatEta(etaSeconds) })}` : ''}`
      return h(
        'button',
        {
          type: 'button',
          className: 'mtd-dock-restore',
          onClick: onShow,
          title: t('dock.show'),
          'aria-label': `${t('dock.show')}: ${label}`,
        },
        h(DockChevron, { up: true }),
        h('span', null, label),
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
          etaSeconds: summary.etaSeconds,
          onShow: () => setHidden(false),
        })
      }

      const name = tasks.length > 1
        ? fill(t('dock.tasks'), { count: summary.unfinished })
        : tasks[0].filename !== ''
          ? tasks[0].filename
          : tasks[0].url
      const size = formatBytePair(summary.receivedBytes, summary.totalBytes)
      const meta = `${size} · ${Math.round(pct * 100)}%${summary.speed > 0 ? ` · ${formatSpeed(summary.speed)}` : ''}${summary.etaSeconds > 0 ? ` · ${fill(t('task.eta'), { eta: formatEta(summary.etaSeconds) })}` : ''}`
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
