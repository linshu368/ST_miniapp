# MiniApp 开屏优化与对照基线

## 目标与冻结基线

完成标准是文档导航零点（WebView 开始加载）到同一指定框架具备展示条件，P95 ≤4000ms。辅助指标为 **>4000ms** 样本数 / 有效样本数；恰好4000ms计为达标。完整内容、视频首帧和业务可操作耗时继续各自统计。

[冻结基线及可复查查询](miniapp-startup-baseline-2026-10-30.json)由已登录 Sentry 只读界面核实：production / release `94c2b66d2c9870c5801cef8931bc6b85d00c12c2`，北京时间2026-10-29 17:26:18至2026-10-30 17:26:18，`startup.shell_ready.duration`、`telegram_ready=sent`。有效样本28，P50=1.19s、P95=6.79s、最大10.51s；>4秒为4/28=14.29%。全部来自首页 `/`；Android/4g 19条、P95=8.65s；iOS/unknown 7条、P95=2.54s；unknown/4g 2条、P95=1.80s。四条超限都在Android组。分位数采用界面显示精度，未伪造逐样本毫秒值。

此前用户提供21条、P50=1.15s、P95=7.91s是更早快照，不能与这份固定窗口混用。基线仅涵盖有就绪回执的有效样本；缺报、后台、离页、JS下载失败不可补成0或声称全部启动成功。相同窗口的迟到入库可能改变以后重查的结果，本文件保留本次观察值。

## 本轮实现范围（本地，尚未部署）

RootLayout在框架HTML之后输出自包含inline脚本。该脚本不依赖Next启动队列、React hydration、Providers、Sentry或完整Telegram SDK，不改React管理的DOM，不读取身份/storage，不发业务请求。静态框架在业务接管前只展示；捕获其中链接点击，避免SDK尚未缓存启动上下文时触发整页跳转，接管后移除该保护。仅首页`/`、角色`/characters`、短剧`/dramas`启用早期路径，其余入口沿用原有完成条件。它检查全局CSS token、实际内容main和主导航的尺寸/可见样式，经过两次RAF绘制机会后，经Android `TelegramWebviewProxy.postEvent` 或iOS/桌面 `external.notify` 发送 `web_app_ready`。这两条原生传输与当前`@telegram-apps/bridge`一致；iframe/普通浏览器/桥接失败继续使用现有SDK兜底。SSR首页与真实业务复用`DramaHomeFrame`，避免提前展示空容器。导航和深链可见性规则保持原实现。

只在内存保留有界时间戳、ready状态和结果。SDK兜底复用同一记录，已发送时不重复通知。首帧前切后台/离页不进入成功耗时分布。CSS/框架未就绪的RAF探测在前台最多15秒，随后交由既有路径兜底；遥测错误不阻塞展示。强退或Sentry/Providers未能加载时记录可能丢失，早期原生通知不依赖遥测送达。

Providers仍按原策略初始化身份和业务；路由脚本下载、数据请求、现有缓存和预取策略不改。本轮不实施第三点的业务分包/预热，也不修改HTML/CDN配置。HTML首字节已超过4秒的单次启动仍不能靠轻量ready达标，需另以真实连接、重定向和边缘交付证据处理。

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

## 本地验收记录（2026-10-30）

- Frontend全量Vitest：64个文件、701项通过；最终桥接/计时/Sentry定向回归51项通过。
- Shared既有Vitest：17个文件、196项通过。
- `pnpm -r typecheck`及Frontend生产build通过；lint只有原有远程图片告警。
- `pnpm test:ui --grep @startup`：7项通过，含JS阻塞、静态导航防跳转、放行后业务继续、ready去重，以及两种宽度的HTML框架。
- 导航/首页刷剧、完整观看进入详情返回、纯净模式/倍速既有流程：8项通过，含390和320宽度。
- 生产HTML中压缩后的inline脚本已在无Next/React/Sentry模块的隔离JS环境验证Android和iOS两条native传输；浏览器截图确认指定框架实际可展示。
- 格式和`git diff --check`通过。原主工作区的已有修改保留；实现位于隔离分支`codex/miniapp-early-ready`，提交和推送状态以Git记录为准。没有数据库/环境/Cloud看板写入或生产部署，线上4秒目标仍待发布后验收。
