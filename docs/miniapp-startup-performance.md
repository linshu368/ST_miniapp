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

Sentry启动时保留错误捕获、Metrics、脱敏和现有日志；BrowserTracing的setup改为首屏load/idle或既有4秒兜底之后动态安装，采样率仍0.2，Replay仍0.05/error1.0。Next SDK本身仍可能把Tracing实现编入公共chunk，本轮不承诺Sentry压缩字节减少；确定改变的是Tracing初始化时机。代价是早期navigation和请求trace细节可能减少，独立启动指标仍采集。Grafana、PostHog及业务采集策略保持原样。

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
