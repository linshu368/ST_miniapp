# MiniApp 开屏优化与对照基线

## 目标与冻结基线

完成标准是文档导航零点（WebView 开始加载）到同一指定框架具备展示条件，P95 ≤4000ms。辅助指标为 **>4000ms** 样本数 / 有效样本数；恰好4000ms计为达标。完整内容、视频首帧和业务可操作耗时继续各自统计。

[冻结基线及可复查查询](miniapp-startup-baseline-2026-10-30.json)由已登录 Sentry 只读界面核实：production / release `94c2b66d2c9870c5801cef8931bc6b85d00c12c2`，北京时间2026-10-29 17:26:18至2026-10-30 17:26:18，`startup.shell_ready.duration`、`telegram_ready=sent`。有效样本28，P50=1.19s、P95=6.79s、最大10.51s；>4秒为4/28=14.29%。全部来自首页 `/`；Android/4g 19条、P95=8.65s；iOS/unknown 7条、P95=2.54s；unknown/4g 2条、P95=1.80s。四条超限都在Android组。分位数采用界面显示精度，未伪造逐样本毫秒值。

此前用户提供21条、P50=1.15s、P95=7.91s是更早快照，不能与这份固定窗口混用。基线仅涵盖有就绪回执的有效样本；缺报、后台、离页、JS下载失败不可补成0或声称全部启动成功。相同窗口的迟到入库可能改变以后重查的结果，本文件保留本次观察值。

## 当前冻结基线B1与逐轮比较

[第一、二点后的冻结快照B1](miniapp-startup-baseline-2026-11-02.json)采用用户提供并再次明确确认的生产单版本数据：`5fffd6ce1dcd0b23504f0e9699bde93ee0eb23ae`，北京时间11月1日11:02—11月2日11:02，production、`startup.shell_ready.duration`、首页`/`、`telegram_ready=sent`。144条，P95=4.55秒，>4秒10/144=6.94%；Android/4g 91条、P95=5.74秒；iOS平台汇总43条、P95=3.76秒。报告未列出的其余10条不擅自补平台/网络分类。未提供的P50、最大值及各组超限数保留null。

B1来源是用户报告及单release确认，本轮没有将它冒充为从Sentry独立实时重算的结果。原始窗口仅给到分钟，JSON明确精度；复查链接采用分钟边界:00，不能承诺复查会完全重现未提供的原始秒边界或迟到入库前的值。487条跨版本累计、419条该版本累计及410条首页累计/P95=5.77秒仅作背景，不混入这份144条基线。B0与B1都保留冻结值，后续查询变化另记新快照，不覆盖历史。

[比较约定与结果入口](miniapp-startup-comparison.json)保留三次直接比较：

- B1对B0：第一、二点共同上线后的观察差额。首页P95降低2.24秒，约32.99%；>4秒比例降低约7.34个百分点。旧基线只有28条，不能将差额全部认定为优化的因果收益。
- 第三点上线后C对B1：相对第一、二点后基线的观察增量。
- C对B0：相对最初基线的总体观察差额。

各项从对应基线直接计算：P95减少量=基线P95−候选P95，减少比例=减少量/该基线P95；超限率减少用百分点。不要把两轮相对百分比、分组P95或阶段P95相加。C暂为null，必须使用用户实际合并并部署后的生产release及真实样本，不能把功能分支commit当生产release，也不能预填第三点收益。

每次同时列出窗口、release、有效样本量、P95、>4秒分子/分母及route/platform/net_type分组，缺数不补0。B0的iOS/unknown和B1的iOS全网络不是已证实相同网络组，不据此认定iOS退化。实际业务数据、视频首帧和跨页体验继续分别检查。

本次交付基底已含B1之后上线的移动端加载及生产预热等变更，因此C对B1/B0展示的是观察差额，不能唯一归因于本次分包。若可获得第三点上线前实际生产release的快照，可另存为补充对照，仍不替换B0/B1。本轮不等待第三点生产数据，不创建PR或执行合并。

## 第一、二点实现范围

第一、二点已上线（用户确认），当前B1已按用户提供并确认的单release快照冻结。文首冻结数据是变更前历史记录，不能当作新基线；本文件原有本地验收记录也不代表当前生产效果。

RootLayout在框架HTML之后输出自包含inline脚本。该脚本不依赖Next启动队列、React hydration、Providers、Sentry或完整Telegram SDK，不改React管理的DOM，不读取身份/storage，不发业务请求。静态框架在业务接管前只展示；捕获其中链接点击，避免SDK尚未缓存启动上下文时触发整页跳转，接管后移除该保护。仅首页`/`、角色`/characters`、短剧`/dramas`启用早期路径，其余入口沿用原有完成条件。它检查全局CSS token、实际内容main和主导航的尺寸/可见样式，经过两次RAF绘制机会后，经Android `TelegramWebviewProxy.postEvent` 或iOS/桌面 `external.notify` 发送 `web_app_ready`。这两条原生传输与当前`@telegram-apps/bridge`一致；iframe/普通浏览器/桥接失败继续使用现有SDK兜底。SSR首页与真实业务复用`DramaHomeFrame`，避免提前展示空容器。导航和深链可见性规则保持原实现。

只在内存保留有界时间戳、ready状态和结果。SDK兜底复用同一记录，已发送时不重复通知。首帧前切后台/离页不进入成功耗时分布。CSS/框架未就绪的RAF探测在前台最多15秒，随后交由既有路径兜底；遥测错误不阻塞展示。强退或Sentry/Providers未能加载时记录可能丢失，早期原生通知不依赖遥测送达。

第一、二点保持 Providers 原身份和业务初始化、路由脚本下载、数据请求、缓存与预取策略；第三点的后续本地实现单列如下。不修改HTML/CDN配置。HTML首字节已超过4秒的单次启动仍不能靠轻量ready达标，需另以真实连接、重定向和边缘交付证据处理。

Sentry启动时保留错误捕获、Metrics、脱敏和现有日志；BrowserTracing的setup改为首屏load/idle或既有4秒兜底之后动态安装，采样率仍0.2，Replay仍0.05/error1.0。Next SDK本身仍可能把Tracing实现编入公共chunk，本轮不承诺Sentry压缩字节减少；确定改变的是Tracing初始化时机。代价是早期navigation和请求trace细节可能减少，独立启动指标仍采集。Grafana及业务采集策略保持原样。

## 指标兼容与上线比较

- `startup.shell_ready.duration` / `startup.telegram_ready.duration` 的导航起点和单位不变，补报使用真实早期时间戳，不能使用Sentry就绪或补报时刻。`measurement=html_post_render_frame`标记HTML路径；早期桥接未成功时，SDK兜底保留原时间口径和`post_render_frame`，避免用未送达的早期时间美化耗时。它们是绘制机会后的保守近似，均不冒充原生遮罩实际消失或屏幕像素确认。
- `startup.budget` count携带`budget=within_4s|over_4s`；与主指标使用相同有效样本和`telegram_ready`过滤。可用旧版已验证的`value:>4000`过滤查询分布，或者新版计数计算超限率，分母不能混用失败/缺报。
- `startup.stage.duration`与慢事件改为`definition=startup_phases_v2`；`startup_bucket=slow`改为>4000ms，`normal`为≤4000ms。历史v1的≥5000ms含义保留，不改历史数据。
- Providers可以晚于HTML shell_ready。v2保留其真实时间及资源摘要，但八段不再承诺分解为shell总耗时；`react_commit`/`paint_wait`等逆序段省略，不补0。资源并集不等于关键路径，也不能与HTML首字节或各段P95相加。
- 发布后以精确新release和固定24小时窗口重查总体及相同route/platform/net_type分组，同时显示count、P50/P95、>4秒数/比例、ready状态和outcome。不能平均分组P95，不能将平台/网络构成变化全部归因于优化。需要继续观察业务可操作与视频首帧有无退化。
- 确认自然样本接收及Android/iOS真机表现后才能判断P95≤4秒是否达成；本地测试或构建通过不代表生产达标。首个版本同时包含轻量展示与Sentry后置，效果归因是这组变更的合并收益；第三点单独发布。

## 验证与回退

复用`page-tracker.test.ts`覆盖脚本可独立执行、两类native传输、样式/框架缺失、后台/离页、桥接失败、去重、补报时间戳及4000ms边界；复用`roleplay.spec.ts`的`@startup`，阻塞Next启动JS时框架和ready仍可完成，放行后原业务请求继续，通知只发送一次。关闭JS仍检查首页/角色/短剧HTML和导航。

运行Frontend typecheck/test/lint/build、全包typecheck和既有UI回归；构建产物还需核对inline脚本在生产压缩后仍无外部模块依赖。真机原生遮罩、Sentry Cloud接收及线上P95需发布后独立验收。回退恢复已验收的Frontend版本；不需要数据库迁移或环境配置写入。

## 第一、二点发布前本地验收记录（2026-10-30）

- Frontend全量Vitest：64个文件、701项通过；最终桥接/计时/Sentry定向回归51项通过。
- Shared既有Vitest：17个文件、196项通过。
- `pnpm -r typecheck`及Frontend生产build通过；lint只有原有远程图片告警。
- `pnpm test:ui --grep @startup`：7项通过，含JS阻塞、静态导航防跳转、放行后业务继续、ready去重，以及两种宽度的HTML框架。
- 导航/首页刷剧、完整观看进入详情返回、纯净模式/倍速既有流程：8项通过，含390和320宽度。
- 生产HTML中压缩后的inline脚本已在无Next/React/Sentry模块的隔离JS环境验证Android和iOS两条native传输；浏览器截图确认指定框架实际可展示。
- 格式和`git diff --check`通过。原主工作区的已有修改保留；实现位于隔离分支`codex/miniapp-early-ready`，提交和推送状态以Git记录为准。没有数据库/环境/Cloud看板写入或生产部署，线上4秒目标仍待发布后验收。

## 第三点最终交付范围（2026-11-02）

用户明确选择保留已上线生产预热，本次只交付启动模块分包及纯展示导航拆分。交付基底是dev `69a722c61106c60c4f9342d225d00a5aa9a2a6b0`，与main `7c4eea5de808e599ebe1aefed8670fb6a7bf095c`代码树完全一致；新首token修复、聊天消息修订、创作与移动端加载改动均保留。

- `EntryShell`只依赖`bottom-nav-shell.tsx`展示；从当前生产提取原导航markup、选中/隐藏规则及意图回调，控制器继续同步挂载。
- `BottomNav`保留生产的移动端策略、相邻目标选择、串行预热预算与清理逻辑。不再加入另一套首页首帧/空闲/单路由调度器，`entry-phase.ts`和媒体观察器相对交付基底无改动。
- 增长/邀请IO在原background阶段才动态导入`deferred-entry-effects.tsx`；启动参数在URL清理前捕获，有效邀请pending提前保留，后台chunk失败降级为空组件，不阻断页面。session去重与失败保留沿用原逻辑。
- 历史首字回执恢复沿用afterFirstScreen门禁再动态导入；聊天发送直接同步导入回执实现，会话列表API不再转导出。即时回报、超时、重试、幂等及恢复实现本身未改。
- 开发工具只在开发期显式打开时加载。身份、支付回流、Replay核心、当前页面和数据hooks没有新增等待门禁，不改变数据缓存key/TTL或签名地址。

这是公共分包增量，不新增Android/iOS专项策略；现有生产平台策略属于交付基底，保持原样。

### 同配置构建对照

先构建干净交付基底，再构建最终候选；两次均使用相同虚构公开Sentry DSN、production环境，不复制实际环境文件。统计生产HTML中现代script去重总和，每文件gzip为本地估算，排除nomodule；不能替代实际编码、缓存、WebView或生产耗时。

- `/`：首批script 24→24；gzip 317,333→318,191字节，增加858字节（约0.27%）。
- `/characters`：首批script 28→27；gzip 319,708→318,361字节，减少1,347字节（约0.42%）。
- `/dramas`：首批script 23→23；gzip 304,246→305,104字节，增加858字节（约0.28%）。
- `/create`：首批script 26→26；gzip 318,996→319,854字节，增加858字节（约0.27%）。
- `/creation`：首批script 31→30；gzip 340,513→339,163字节，减少1,350字节（约0.40%）。
- `/profile`：首批script 26→26；gzip 319,224→320,082字节，增加858字节（约0.27%）。

六入口首批script和preload均不再包含归因/历史回执实现标记，确认分包边界生效。公共chunk划分使最终总量并非全部下降：首页约增加0.27%，不能宣传为首页JS减量或P95已改善。此次只验证模块导入/执行时机和依赖边界，收益必须等待生产样本；功能回归不证明性能无退化。

### 验收与人工发布交接

- 最终交付基底上的Frontend既有测试：67个文件、732项通过；Shared：18个文件、229项通过。全包typecheck、Frontend lint、依赖边界/遗留引用检查及前后两次生产构建通过；lint仅有已有图片告警。
- 页面回归首轮共88项，87项通过、1项失败。失败发生于聊天路由首次开发编译耗时10.6秒，测试在跳转完成前触发10秒操作超时；已在既有点赞用例两次跳转后等待聊天URL完成，没有扩大超时或加入固定睡眠。
- 修正后复跑`@chat-like|@startup|@navigation`，15项全部通过，覆盖原失败项、导航、无JS框架及可选启动chunk失败；UI测试包typecheck通过。首轮88项不记为一次全绿运行。
- 源码不变量检查确认生产导航控制器、预热、媒体观察、首token实现及第一/二点计时逻辑保持原样。格式、差异空白和冻结JSON校验通过；原主工作区已有文件未被覆盖。

本轮不创建Trellis任务、PR或执行合并；工程师手动开PR并完成合并。功能分支为`codex/miniapp-startup-split`，建议PR base为dev。合并生产后记录真实release与部署时间，再按上文对B1、B0分别比较；所有CI/Preview/生产结果与本地检查分开记录。

历史本地记录已保留在隔离worktree外的`../evidence-2026-11-02/`：51d5b2a曾通过744项Frontend、212项Shared、38项定向UI，5fffd6c曾通过78项UI，但实现范围与当前交付不同，不冒充当前版本检查。最终构建、逐文件清单、源码不变量和日志另存`../evidence-2026-11-02/delivery/`。

## HTML 首字节等待诊断（2026-11-03）

本次仅扩展既有 `miniapp_startup_slow` 的 `contexts.startup`，不改变开屏定义和起止点、measurement、4秒边界、有效样本过滤、采样及每文档去重。`startup.shell_ready.duration`、`startup.telegram_ready.duration`、`startup.budget`、`startup.stage.duration` 和 `definition=startup_phases_v2` 保持原样。新增字段只进 `details`，不进 `stages`，因此不新增指标调用、事件、出口或主动网络请求。正常启动没有新增明细事件。

复用 `startup-timing.ts` 在 ready 后既有的 `setTimeout` 收集回调；不新增 timer、listener、await、依赖、存储读写或 flush，不改变身份初始化、数据请求、脚本加载和后台预热。收集器新增固定20个数值字段，版本为 `navigation_diagnostics_version=1`；版本存在不保证底层 Timing 字段可用。Timing 缺失/异常只影响诊断，旧指标保持原样。新增字段由 `STARTUP_DETAIL_FIELDS` 进入既有脱敏白名单，不携带 URL/query、initData、请求头、IP 或用户标识。

### 字段与解释

原始字段均为相对本次文档导航零点的毫秒偏移，名称对应如下：

- `document_fetch_start`：fetchStart。
- `document_dns_start/end`：domainLookupStart/End。
- `document_connect_start/end`：connectStart/End。
- `document_tls_start`：secureConnectionStart。
- `document_request_start`：requestStart。
- `document_response_start/end`：已有 responseStart/End。
- `document_redirect_start/end`：redirectStart/End；`document_redirect_count` 是次数，不是耗时。
- `document_worker_start`：workerStart；0不直接证明没有任何后台线程影响。

新增分段（毫秒）：

```text
document_pre_fetch          = fetchStart
document_fetch_to_dns       = domainLookupStart - fetchStart
document_dns                = domainLookupEnd - domainLookupStart
document_dns_to_connect     = connectStart - domainLookupEnd
document_connect            = connectEnd - connectStart
document_connect_to_request = requestStart - connectEnd
document_request_wait       = responseStart - requestStart
document_tls                = connectEnd - secureConnectionStart
```

前七段在端点完整且全链有序时之和等于既有 `document_ttfb`；缺段或乱序不强行补齐。TLS是connect的子区间，不与七段重复相加；重定向与worker原值仅作辅助，也不另外相加。`document_request_wait` 包含发送、网络往返及响应等待，不是服务端CPU。原始时间点必须有限、非负且不晚于采集时刻；缺失、不合法或逆序段省略。合法0保留，但 `secureConnectionStart=0` 不计算TLS耗时；TLS起点还必须位于连接区间内。

连接复用/缓存、隐私限制会影响字段；重定向字段为0不能证明没有跨域重定向。连接前的大空档只标记位置，不能直接命名为排队、TCP超时或代理问题。Navigation Timing不能完整列出失败连接尝试；详细解释参见 [Navigation Timing](https://www.w3.org/TR/navigation-timing-2/)。各阶段P95不能相加，也不能把诊断采集结束时间当作开屏结束时间。

### Sentry 查看与验收

在生产/TEST各自环境检索 `miniapp_startup_slow`，按真实release、固定时间窗口、`route=/`、`tg_platform=android`、`net_type=4g`、`telegram_ready=sent`筛选，在事件详情JSON的 `contexts.startup` 查看 `document_ttfb` 和新分段。Android与iOS分别看，`4g`是effectiveType质量分类，不等于实际移动网络。慢事件只覆盖既有slow触发样本，不代表全部启动；总样本量与P95仍从原指标查询。新字段没有加入全量分段分布，不能将其描述为新增全量P95报表。

本轮按用户明确要求跳过全部本地验证及commit/push hooks：新增用例仅编写，没有运行测试、typecheck、lint、build、UI或真机验收。历史章节的通过记录不属于本次改动。后续必须确认TEST Sentry实际入库并显示新字段；SDK调用、HTTP成功或远程推送不能替代Cloud实收。目标安卓机新增计算P95≤1ms、诊断字段增量≤2KB，以及关键JS/业务接口发起时序与业务展示无退化均待验收；不能凭ready后异步就宣称零开销或P95已达4秒。

### Android 真机网络日志

使用自己的测试手机和当前稳定版Telegram/WebView，先记录系统、Telegram、实际WebView版本、实际Wi-Fi/移动网络和代理/VPN状态。不要为了抓日志先更换WebView provider、禁用缓存或改网络路径。分别标记Telegram进程冷启动、仅重开MiniApp、页面刷新，避免混组。

1. 手机开启开发者选项/USB调试；Telegram设置页底部长按版本号两次，在Debug Settings启用 **Enable WebView Debug**。USB连接电脑并授权。见 [Telegram官方步骤](https://core.telegram.org/bots/webapps#debug-mode-for-mini-apps)。
2. 使用 `adb shell am start -a "com.android.webview.SHOW_DEV_UI"` 打开手机WebView DevTools；在Flags启用 `net-log`，停止并重启Telegram使其生效。这是测试设备上的临时诊断设置，不需要修改网站代码或生产服务配置。
3. 从固定入口打开MiniApp，记录准确时间，仅复现首页启动。复现后关闭Telegram，在WebView DevTools的 **Net Logs** 导出日志。M128起支持该入口，设备若缺少该能力，记录版本并保留HAR，不切换provider冒充同条件样本。见 [Chromium说明](https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/net-debugging.md)。
4. 核对首页HTML对应的DNS、代理、连接池等待、TCP/TLS尝试、失败重试与响应时间，解释分段中的大空档。结束后恢复本次开启的net-log设置并重启Telegram。
5. HAR补充：电脑Chrome打开 `chrome://inspect/#devices`，Inspect对应Telegram页面；Network勾选Preserve log，No throttling，不勾Disable cache。保留首页Document的Timing、协议、状态和 `x-vercel-id` / `x-vercel-cache`；导出 **HAR (sanitized)**，分享前仍检查自定义鉴权头、启动参数和业务正文。默认HAR脱敏不等于项目敏感字段已全部移除，见 [Chrome说明](https://developer.chrome.com/docs/devtools/network/reference/#save-all-network-requests-to-a-har-file)。

首次打开后才连接DevTools可能漏掉最早阶段；刷新HAR必须标为刷新样本。抓首次打开优先在打开前启用WebView NetLog；Chrome自身的 `chrome://net-export` 不能替代Telegram WebView日志。抓日志会引入诊断开销，主要用于定位失败/等待，不能拿调试状态下的少量启动代替自然生产P95。日志在本地受控分析，分享前脱敏，不提交Git。
