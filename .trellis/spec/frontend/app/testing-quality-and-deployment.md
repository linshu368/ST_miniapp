# Frontend 测试、质量、性能与部署

## 当前测试基础与要求

当前 Vitest 重点覆盖纯逻辑/API parser/store：conversation SSE、会话标题、模型 cache、聊天入口/额度弹窗、composer 布局/回复展示、Telegram hooks/launch URL、Sentry sanitize、通知工具、用户 profile store，以及 Next lobby route。暂无完整 RTL/jsdom/E2E 体系；不能把缺失说成已覆盖。

开发期页面验收位于 `packages/ui-tests`（[使用说明](../../../../packages/ui-tests/README.md)）：`pnpm preview:ui` 启动真实页面与本地虚构API，`pnpm test:ui --grep @profile` / `@roleplay` / `@chat` / `@image` 按组复跑。默认390×844、narrow项目320×568。公开契约约束fixture，未知接口501并使验收失败；无生产代理，自动浏览器拦截外网。手动3120/3121与自动3130/3131独立，串行场景重置；本地Next开关隔离缓存与派生tsconfig，生产仍用默认配置。截图/trace/报告不提交。原有逻辑/计费/迁移测试保留；系统键盘、Telegram原生保存和真实供应商调用继续专项验证。

- 纯函数/转换：边界值、非法输入、时区/金额、空数组。
- API/SSE：headers、envelope、非 2xx、abort、chunk 分割、error/EOF、cache invalidation。
- Store：hydrate 优先级、localStorage 失败、action 不变量。
- 页面/组件新增关键逻辑时优先保持可测试边界；只有测试必要性已确认时才抽取纯函数或引入最小 DOM 测试基础设施，避免为测试制造无业务价值的抽象。
- Bug 修复先在规划/风险评估中确认是否需要复现测试文件，未确认时不自动创建。支付、发送/重生成、删除、邀请/奖励始终至少执行现有相关测试和可重复人工场景。

## 质量命令

```bash
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
```

shared contract 改动追加 `pnpm --filter @miniapp/shared test` 和所有消费者 typecheck。检查组件无直接 fetch、无数据获取 useEffect、无 DB 行类型、无其他应用 import、无新增 `any`/CSS、无 ST bridge 代码。

## 人工验证矩阵

- Telegram WebView 与普通浏览器 fallback；真实/缺失 initData；冷启动和重新前台。
- 320px/常见移动宽度、安全区、横竖屏、软键盘、长文本/长列表、慢网/离线。
- 大厅 loading/error/empty、详情/收藏；聊天首轮/历史分页/SSE/错误/取消/重生成/会话管理；语音播放/生成。
- 充值下单、回跳、pending→终态、重复点击；订单/流水分页；通知/客服已读；邀请/社区失败与重复操作。
- 键盘 Tab、焦点恢复、screen-reader label、reduced motion、对比度。

## 性能、监控与安全

- 列表图片声明尺寸并延迟加载；避免 render 中 O(n²)，音频用 map；稳定 key/memo 只在测量后使用。
- 大组件按功能拆分但不创建无意义 wrappers；重依赖/Devtools/replay 延迟或仅相应环境加载。
- Sentry 事件必须经 sanitize；禁止 initData、token、支付信息、聊天正文、完整 API body。`global-error` 提供 reset，但不暴露内部错误。
- Grafana 工程出口仅允许白名单 measurement/event 与 app/公开 SDK 版本 meta。托管 intake 要求的随机 `X-Faro-Session-Id` 仅在 exporter 内存期复用、只入请求头，不持久化、不进入 body/事件属性/聚合标签、不绑定业务用户；不得因此恢复 SDK session/user/page/browser/trace meta 或自动 instrumentation/Replay。SDK 的 Web Storage 可用性探测不等于允许持久化该标识。
- Faro 2.13 默认传输的 `Idempotency-Key` 与当前托管入口 CORS 不兼容；工程出口仅扩展公开 `send/promiseBuffer/getTransportBody`，复用 20 批/并发 1 的原队列，出队后单次 fetch 三秒超时，不重试、不读取响应正文、不改全局 fetch 或 SDK 私有字段。Node 202 不替代浏览器 OPTIONS/POST 和 Cloud 实收验收。
- Session Replay 画面的聊天正文例外见 `api-dataflow-and-state.md`：PostHog 与现有 Sentry Replay 允许显示用户输入和模型回复；该例外不适用于 Sentry 事件、日志或自定义事件属性。Sentry Replay 现有 `maskAllText: false` 不改；采样策略见 `.trellis/tasks/10-21-sentry-ux-monitoring/design.md` §4（2026-10-21 起：普通 trace 与 Replay 会话降采样，慢请求/卡顿/报错事件全量上报并带 Replay，不再是 100% 采样）。当前 PostHog 为 Free 套餐，Session Replay 最长保留 **30 天**；不得按 60 天描述或验收。
- Markdown 始终 sanitize；外链/图片 URL 使用允许协议；不得用 `dangerouslySetInnerHTML` 绕过现有安全层。
- 回复后处理至少覆盖 artifact 好坏隔离、旧 `NULL`/缺失版本原文退化、流式不挂载 renderer、终态 choice 可用和同步防双击。真实 Worker 安全/DOM 行为由 `@miniapp/reply-renderer` 测试承担；Telegram WebView 真机仍是发布门禁。

## MiniApp 启动框架与 P95

- `Providers` 在 Telegram 初始化前输出 `EntryShell`：角色入口 `/characters` 复用 `LobbyShellSkeleton`，短剧列表复用 `DramaListHeader`/`DramaGridSkeleton`，导航复用无请求的 `BottomNavShell`；首页保留页面容器和主导航，不显示“加载中”文字，其他入口提供通用加载提示，深层路由沿用导航隐藏规则。初始化前不挂业务 reader，不读取身份或 storage。短剧数据/封面仍异步加载。
- 初始化完成后，`startup-timing.ts` 检查框架并等待两次 `requestAnimationFrame`，给浏览器一次绘制机会，然后经 SDK `miniApp.ready()` 通知 Telegram 展示。不能用 `init()`、接口返回或封面 onLoad 替代该通知；普通浏览器/旧客户端安全降级，遥测失败不能影响 ready。
- `startup.shell_ready.duration`（distribution，ms）：本次文档导航到初始化后框架提交并获得绘制机会的耗时，包含 HTML/JS 下载和 hydration。`measurement=post_render_frame` 表示它是框架可展示时间的保守近似，可能晚于静态 HTML 的实际首绘；不是 FCP、完整内容就绪，也不是原生遮罩实际消失时刻。
- `startup.telegram_ready.duration`（distribution，ms）：同一起点到成功发送 `ready()`；`unavailable`/`failed` 不生成这条指标。shell 指标的 `telegram_ready=sent|unavailable|failed` 可区分真机与降级。
- 两指标每份文档最多一次，SPA 切页和 BFCache 恢复不重记；StrictMode 清理不会伪造离开。`startup.outcome`（count）记录 `shell_ready|background|left|missing_shell`；观察期间切后台/提前离开的样本不进入耗时分布，恢复前台后仍通知 Telegram 展示。未执行到埋点的 JS 下载失败/初始化失败及用户点击入口到 WebView 导航前的等待不可观测，不能声称覆盖全部打开次数。
- 指标只带入口路由模板、`tg_platform`、`net_type`、`measurement` 和 ready 状态，不含用户 ID、完整路径、query、initData。未知路由归 `/other`。`beforeSendMetric` 只对 `startup.*` 使用属性白名单，移除 SDK 自动附加的用户身份/Replay ID，保留 `sentry.release`、`sentry.environment` 和 SDK 版本；其他指标沿用既有处理。无需新服务或新环境变量。
- P95：在 Sentry Metrics 选择 `startup.shell_ready.duration`，聚合 `p95`，过滤 `sentry.environment=production`、`telegram_ready=sent`；按 `route` 分组并显示 `count`。通过 `sentry.release` 比较版本，按 `tg_platform` 分开 Android/iOS；`startup.telegram_ready.duration` 同口径另画。`startup.outcome` 同时显示各结果计数，不能将失败填成 0ms，也不能平均各分组 P95。历史 `page.ready.duration` 起点不同，不能用于此指标的旧版对照或回补。
- 本地回归：`pnpm test:ui --grep @startup` 在关闭 JS 的移动浏览器中验证首页/角色/短剧 HTML 的框架、主导航、无业务请求和无横向溢出；`page-tracker.test.ts` 覆盖导航零点、单次上报、StrictMode、后台/离开、桥接/遥测失败。Telegram 原生遮罩与线上指标接收仍需发布后的真机验证。

### ready 前分段诊断（本地增量，待发布）

- 复用 `startup-timing.ts`、Sentry Metrics 和现有 `beforeSend`；新增轻量 `startup-phases.ts` 只记录首次单调时钟时间戳。Providers 模块执行后、首次 render、SDK 初始化前后、用户资料/启动副作用结束打点；StrictMode 和 rerender 不覆盖首次时间。无新网络出口、环境变量、数据库或依赖。
- `startup.stage.duration`（distribution，ms）带有限 `stage`、`startup_bucket=normal|slow`、`definition=startup_phases_v1`，保留入口模板、平台、网络与 ready 状态。连续阶段为 `before_providers → module_to_render → render_to_init → telegram_init → bootstrap → react_commit → paint_wait → ready_call`。`before_providers` 包含 HTML/JS 加载、依赖模块执行与 Next 启动；`render_to_init` 包含 React 调度到初始化前的等待；`bootstrap` 包含身份解析、遥测延后注册与 profile hydrate；`react_commit` 是启动副作用结束到就绪 effect 的等待，**不是纯 hydration CPU 时间**。只有同一次完整、顺序合法的八段可相加；缺失、非有限、逆序数据不补 0。
- 额外解释性阶段 `document_ttfb` 从文档导航零点到 HTML 首字节（包含连接/请求/服务端等待），`document_download` 为 HTML 接收时长；`next_script_fetch_union` 为 Providers 模块就绪前已完成的同源 `/_next/static/*.js` 资源加载区间并集，`last_script_to_providers` 是最后这类响应结束到模块就绪的间隔。HTML 流式返回与脚本并行加载可重叠，这四项**不能叠加到连续八段**，也不证明脚本均在关键路径。最多检查资源缓冲的前 128 条并显式带 `resources_truncated`；摘要只有时间、数量、传输字节。`script_zero_transfer_count` 不是缓存命中率，0 字节可能来自缓存或其他浏览器交付方式；资源缺失也不能证明没有下载。
- 原有两项总耗时与 ready 调用顺序不变；分段计算和上报通过 ready 后的单次异步任务执行，不等待收集或上报，失败安全降级。原有后台/提前离开样本排除规则不变。新数据最多每份文档一次；ready 前离开、JS 未执行或计时 API 缺失仍有观测盲区，不能冒充覆盖全部打开次数。
- 成功进入耗时分布且框架耗时 ≥5000ms 时，额外记录一条 `miniapp_startup_slow` info 事件，`contexts.startup` 同时包含该次所有已知阶段和导航/资源摘要，统一 fingerprint；不依赖 transaction 采样。`beforeSend` 对这类事件使用字段白名单，删除 SDK 合并的 user、request、breadcrumbs、extra、trace、Replay 和其他上下文；其他事件处理不变。不采集资源 URL、用户身份、initData 或正文。分段指标全量；慢事件只覆盖 ≥5s，不扩大已有 trace/Replay 会话采样率。
- 查询：在 Sentry Metrics 选 `startup.stage.duration`，过滤 `environment:production`、目标 `release`、`telegram_ready:sent`、`definition:startup_phases_v1`，按 `stage` 分组显示 count/p50/p95，可加 `startup_bucket:slow`。UI 搜索字段是 `environment`/`release`（SDK 内部属性仍为 `sentry.environment`/`sentry.release`）。在事件中搜索 `miniapp_startup_slow` 查看同次 `contexts.startup`；**不能把各阶段 P95 相加，也不能用跨版本总体与旧版少量样本声称优化幅度**。总耗时不变而 before_providers 高时，结合 TTFB、资源并集和末资源间隔继续区分网络与客户端启动；只据摘要不宣称精确 JS 执行或原生遮罩消失时间。
- 复用 `page-tracker.test.ts` / `sanitize.test.ts` 覆盖并行资源、合法零值、缺失/逆序、StrictMode、单次/慢阈值、异步上报、后台排除和 SDK 附加字段过滤。上线后仍需用 Telegram 真机验证 ready、阶段指标与慢事件实际接收；本地通过不代表生产已启用。回退本次前端提交即可停止新增指标/事件，保留原启动总耗时。

## Vercel 部署

短剧 CDN 对照使用正常播放器，独立实验页面／接口已移除。固定 `@drama` 验收补充关闭后重新取址及首播完成后的快进诊断；TEST／生产／真实 Telegram 性能分别验收，见 [操作说明](../../../../ops/drama-cdn-rollout.md)。

PR #525 已移除独立 `/drama-cdn-experiment` 页面及实验取址/上报。复用 `packages/ui-tests` 的 `@drama` 场景验证普通播放、切集、重试及旧入口 404；模拟验收不能替代 Telegram 真机性能，操作与恢复见 [说明](../../../../ops/drama-bunny-preview/README.md)。

- Frontend 部署 Vercel，配置见根/包部署文件和 `next.config.mjs`；`NEXT_PUBLIC_*` 都是公开值，secret 不得使用此前缀。
- Next.js 只把**静态成员访问** `process.env.NEXT_PUBLIC_*` 内联进客户端包。经 `const env = process.env` 再读属性时，Preview/生产 bundle 里永远是 `undefined`，PostHog adapter 会走 `missing_config` no-op。`readPostHogBrowserEnv` 必须静态读取 `NEXT_PUBLIC_POSTHOG_KEY/HOST`。
- Preview 可注入 PostHog 公开变量做真机验收；Production 留空即关闭。打开生产采集是独立运维步骤，不随功能 PR 默认启用，也不改变现有 Sentry Replay。
- Preview/production 的 `NEXT_PUBLIC_API_URL` 必须指向匹配 Backend。Feature PR 按 `VERCEL_GIT_PULL_REQUEST_ID`（或自定义环境名 `pr-{n}`）1:1 指向 `https://stminiapp-pr-{n}.up.railway.app`，构建时覆盖 Preview 共享变量里上一轮 PR 的残留值；`dev` 分支指向 development，production 指向 production。构建采用 standalone 并转译 shared。环境变化同时验证 CORS、Telegram Bot WebApp URL、Sentry release/source maps。
- 数据库 migration 和 Backend 部署与 Frontend 解耦；契约演进遵循兼容 producer-first 顺序。
- 发布前 `build` 必须通过；发布后 smoke test 首页、health/API、聊天、支付回跳并监控错误率。回滚 Vercel deployment 时确认 Backend/契约仍向后兼容。

## 短剧播放分段计时

工程质量窗口为本节启动诊断之外的明确例外：复用同一src观察器，在Faro启用且确认前台实际播放后每30秒及暂停/seek/后台/结束/释放边界提交单条成对playing_ms/rebuffer_ms增量；禁止逐帧/timeupdate上报。排除首次加载、暂停、seek、后台，超60秒未观测空洞不补时；未恢复卡顿在退出前已发生的时间保留。累计播放采用walltime，不用媒体进度差；startup不可改写终态不能阻止后来手动成功的实际播放被观察。两时长合计须0<sum<=60000且原子白名单校验，窗口清零防重复；加权占比sum(stall)/sum(play+stall)，不可平均单窗比例或把窗口数当人数。统一出口入队前补有限Telegram平台/有效网络等级，不采集UA/机型/身份。两维筛选同时作用成功/失败/样本分母，默认.\*保留旧缺标签；unknown不等于弱网。

v2 的实现/口径与验收见 [短剧看板操作说明](../../../../docs/grafana/drama-playback-runbook.md)。复用原tracker，新增轻量start（微任务让点击先发/play）、被动媒体网络与首帧/长任务摘要；最多16资源条目/128内部长任务区间，所有截断显式。启动后有最多5秒的网络尾观察，可补一次network报告；不改启动终态，播放中卡顿恢复和质量窗口走原工程出口。缺失与逆序在分析视图保持NULL，首帧/启动完成分开。Backend先兼容契约；分析表未迁移/启用前继续日志模式。

`lib/perf/drama-timing.ts` 管理列表/每次播放的单调时钟节点、查询和 HTTP 尝试；`drama-media.ts` 绑定本次 src 的事件/帧回调，`drama-observer.ts` 先用 createLogger 打印，再经 `lib/api/telemetry.ts` 的鉴权 POST 将报告集中写入 Railway；短剧专用 Sentry 上报已移除。上传 keepalive、background 优先级、总预算 5 秒且不重试，不参与播放结果；失败保留本地日志，不做离线补传。根 `PagePerfTracker` 管理入口与离开/后台监听。用户浏览时间独立于启动等待，预取与路由并行，不允许阶段简单相加。

`apiClient.onAttempt` 仅为可选的本地观测回调，包含排队、响应头与 body 解析，不能传入 fetch 或改变重试/超时。短剧 query 禁用 structural sharing，以保留结果对象与本次计时 WeakMap 的对应；实际播放 query key 包含本次 intent，旧地址／预取不能绕过关闭；两组统一确认路径，签名缓存仍在后端。播放器持有本次观察对象，旧组件更新不能重建/抢占导航目标的记录。成功必须同时有首帧与 playing；兼容降级明确标记，不能使用 canplay 代替。

首页 embedded 与详情播放器的测量归属必须明确区分（home/detail），只在内存持有。子播放器 effect 可先于根 route effect：route('/') 应保留首页活跃观察，真正离开其 owner 路径才记 left；首页↔详情即便同剧也不能复用，同归属显式换剧/换集保留 switched。重复 ensure 不重启已终态，旧组件不能抢回新观察。既有 drama-timing 测试须覆盖这种 effect 顺序及跨归属/离页/后台；不为测量重建 src/播放业务 effect。

每次等待超过 5 秒生成一次快照；失败、离开、后台等都生成终态，后台不计成慢播放。遥测异常不得影响请求/视频，地址/签名/对象路径不得进日志；上传契约按字段白名单和明细数量限制，禁止任意对象作为日志输入。关键回归及查询、发布、真机验收见 [排查说明](../../../../docs/drama-playback-timing.md)。

媒体启动诊断在原报告的可选 `media` 中记录最多 32 条有界事件，以及慢/终态时即时 `snapshot`。`play_called/play_resolved/play_rejected/loadeddata/canplay` 首次 marks 独立于事件截断；原 `playing + first_frame` 成功条件和手动/自动 play 的业务结果保持不变。不得逐帧记录 progress/timeupdate 或周期轮询。状态只含有限数值、布尔与枚举；bufferedAheadMs 只算覆盖当前位置的连续缓冲，读取失败为缺失，不得把远端缓冲、suspend 或零/缺失数据直接解释为网络根因。reader 在终态/媒体释放时解除，旧监听/Promise 不得写新流，慢快照不可被后续事件改写。通过既有 drama-media/observer/timing 测试验证，Backend 接受新契约后再发 Frontend。

## 短剧统一测量v3（本地实现，待发布）

1. **Scope / Trigger**：短剧目录、首页/详情启动、阶段和诊断统一；播放控制、签名和后端计时不改。
2. **Signatures**：shared `dramaTimingStages(marks)` 返回有限stages；报告兼容增加 `definition?: drama_v3`、`route?: /|/dramas|/dramas/:id`、`purpose?: diagnostic` 和四个有限阶段字段。兼容报告version仍2。
3. **Contracts**：新tracker/日志/Faro共用阶段helper；缺失/逆序不补0，合法0保留。原elapsedMs和first_frame+playing终态不变。目录route/起点随观察绑定，background在owner内生成，不能在出口按当前路径/可见性猜测。构建SHA统一Grafana/DRAMA release。NEXT_PUBLIC_DRAMA_TIMING_MODE默认legacy；显式unified且Faro配置有效时，全量统计走Faro，100%≥5秒/非成功和5%不足5秒成功有界明细走Pino，符合条件的final/network另经Backend OTLP写Loki，专用start停发，diagnostic永不入分析库。
4. **Validation & Error Matrix**：旧报告兼容；未知definition/route/purpose和敏感嵌套字段400，超body413，限流429，Pino失败仍尝试独立Cloud出口。202仅accepted；接口、repository和历史导入器均防止diagnostic落表。Faro关闭/非法配置保留legacy，遥测故障不得改变播放。
5. **Good/Base/Bad Cases**：Good：首页启动仍归/，元数据→画面数据→首帧新段有有效N；Base：旧客户端和默认legacy继续原上报；Bad：迟到报告借当前页面归属、逆序填0、把5%日志用作总体成功率、把final与network当两次启动。
6. **Tests Required**：扩展既有shared telemetry-contract、frontend drama-timing/observer/media/grafana及backend telemetry回归；所有消费者typecheck，相关lint/build。Cloud查询可执行不等于新信号往返或真实Telegram验收；本地@drama现有场景可复用作后续重复验收，不新增临时mock体系。
7. **Wrong vs Correct**：Wrong为在SQL/前端另写新阶段计算并默认关闭旧链路；Correct为复用唯一helper，v3筛选隔离历史，Backend兼容→Frontend默认双轨→TEST/Cloud/真实流程验证→独立批准unified；接收端已按五秒长尾方案停止分析写入。旧表/视图/历史看板/保留期job本轮不删除。

字段、诊断粒度、分母和切换恢复统一见 `docs/drama-playback-timing.md`。

旧固定样本独立实验入口／自动 AB 序列已移除。普通 `@drama` fixture 覆盖关闭重取址和独立快进帧报告；不代表真实分发性能。

## 生产 CDN 对照与统一测量兼容

1. **Scope / Trigger**：工程看板CDN对照候选（本地，未发布）沿用既有响应delivery与Faro链路，不改变播放、分流或SQL停写行为。
2. **Signatures**：Frontend局部 `dramaCdnAttributes(delivery?: DramaDelivery): Record<string,string>` 快照原始桶与实际节点；原启动final投影原子携带cdn_budget，不新增HTTP合同。
3. **Contracts**：统一出口仅增加有限 `cdn_experiment/group/provider/reason/budget`；实验ID最多8种、64字符，非法/疑似个体ID归unknown，溢出other，禁止去重码、URL和身份进入Faro。只有首帧+playing且原始单次elapsedMs<=5000为within_5s，超出为over_5s，未开播/缺证据/后台分别not_started/unmeasured/background；成功分位仅用within/over的有效measurement。主率=within/(within+over+not_started)，默认排除retry，不以首页文档/重试累计时间替代。
4. **Validation / Error Matrix**：无delivery保持unknown，start不事后补组；未知新投影和无标签历史分开，不声称实验精确缺报或人数。每src媒体观察器快照delivery，迟到清尾保持原身份；质量窗口同批成对时长加权，总和(0,60000]，不平均比例。cdn_experiment只作用新增CDN区，cdn_entry只作用其启动面板，其他启动/目录/首张画面筛选不能假装作用质量窗口。遥测故障仍不影响播放。
5. **Good / Base / Bad Cases**：Good为原Bunny桶关闭后实际Supabase仍保留原组；Base为旧客户端/缺delivery继续正常播放且不推断分组；Bad为把后台/缺证据当达标、重试覆盖首次失败或将seek/network重复计数。
6. **Tests Required**：既有grafana/observer/media回归覆盖阈值精度、unknown、disabled回退、重试隔离、敏感字段与基数、旧源尾窗；既有Faro→Alloy→Loki脚本执行实际查询并验证分母、空桶、全失败真实0和加权比例。日志面板走range端点，所有Grafana变量含doublequote先明确替换；不得以空查询语法通过代替合成数值断言。
7. **Wrong vs Correct**：Wrong为整张覆盖Cloud或把本地通过当生产实收；Correct为源码JSON与Cloud布局分别核对，发布仅追加候选面板/变量并重算y，保留云端其他新增区；真实Cloud新字段和Telegram性能独立验收。

实验两组保留相同播放器、v3阶段helper、home/detail归属与Faro投影；seek仅走原Pino，不投startup工程分母。开流前确认NEXT_PUBLIC_DRAMA_TIMING_MODE=legacy及实际构建，以保留完整start/终态；unified下有delivery的结果与seek仍全量上传，非实验采样保持。5秒只拍快照，不终止播放；重试保留原失败与累计等待。发布与验收矩阵见ops/drama-cdn-rollout.md。
