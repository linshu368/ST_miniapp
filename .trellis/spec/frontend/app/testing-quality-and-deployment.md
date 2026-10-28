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
- Session Replay 画面的聊天正文例外见 `api-dataflow-and-state.md`：PostHog 与现有 Sentry Replay 允许显示用户输入和模型回复；该例外不适用于 Sentry 事件、日志或自定义事件属性。Sentry Replay 现有 `maskAllText: false` 不改；采样策略见 `.trellis/tasks/10-21-sentry-ux-monitoring/design.md` §4（2026-10-21 起：普通 trace 与 Replay 会话降采样，慢请求/卡顿/报错事件全量上报并带 Replay，不再是 100% 采样）。当前 PostHog 为 Free 套餐，Session Replay 最长保留 **30 天**；不得按 60 天描述或验收。
- Markdown 始终 sanitize；外链/图片 URL 使用允许协议；不得用 `dangerouslySetInnerHTML` 绕过现有安全层。
- 回复后处理至少覆盖 artifact 好坏隔离、旧 `NULL`/缺失版本原文退化、流式不挂载 renderer、终态 choice 可用和同步防双击。真实 Worker 安全/DOM 行为由 `@miniapp/reply-renderer` 测试承担；Telegram WebView 真机仍是发布门禁。

## Vercel 部署

固定 Bunny 手机实验使用独立 `/drama-cdn-experiment` 和真实 `DramaPlayer`，取址沿用 `lib/api/drama.ts`，实验缓存键隔离于普通播放，不因 focus/reconnect 自动换 URL。正式顺序 AB/BA/AB，起播含取址/播放器等待、另存 src→首帧；seek 先检查 buffered，再分别记录目标帧和恢复推进，15 秒有界且不自动重试。失败/中断/回退存本机有界记录，不采集签名或原始 HAR；缓存头不可读必须 UNKNOWN。真实 Telegram 手机是性能门禁，参见 [本轮说明](../../../../ops/drama-bunny-preview/README.md)。

- Frontend 部署 Vercel，配置见根/包部署文件和 `next.config.mjs`；`NEXT_PUBLIC_*` 都是公开值，secret 不得使用此前缀。
- Next.js 只把**静态成员访问** `process.env.NEXT_PUBLIC_*` 内联进客户端包。经 `const env = process.env` 再读属性时，Preview/生产 bundle 里永远是 `undefined`，PostHog adapter 会走 `missing_config` no-op。`readPostHogBrowserEnv` 必须静态读取 `NEXT_PUBLIC_POSTHOG_KEY/HOST`。
- Preview 可注入 PostHog 公开变量做真机验收；Production 留空即关闭。打开生产采集是独立运维步骤，不随功能 PR 默认启用，也不改变现有 Sentry Replay。
- Preview/production 的 `NEXT_PUBLIC_API_URL` 必须指向匹配 Backend。Feature PR 按 `VERCEL_GIT_PULL_REQUEST_ID`（或自定义环境名 `pr-{n}`）1:1 指向 `https://stminiapp-pr-{n}.up.railway.app`，构建时覆盖 Preview 共享变量里上一轮 PR 的残留值；`dev` 分支指向 development，production 指向 production。构建采用 standalone 并转译 shared。环境变化同时验证 CORS、Telegram Bot WebApp URL、Sentry release/source maps。
- 数据库 migration 和 Backend 部署与 Frontend 解耦；契约演进遵循兼容 producer-first 顺序。
- 发布前 `build` 必须通过；发布后 smoke test 首页、health/API、聊天、支付回跳并监控错误率。回滚 Vercel deployment 时确认 Backend/契约仍向后兼容。

## 短剧播放分段计时

v2 的实现/口径与验收见 [短剧看板操作说明](../../../../docs/grafana/drama-playback-runbook.md)。复用原tracker，新增轻量start（微任务让点击先发/play）、被动媒体网络与首帧/长任务摘要；最多16资源条目/128内部长任务区间，所有截断显式。成功后只有最多5秒的网络尾观察，可补一次network报告；不改播放终态，不采集播放中卡顿。缺失与逆序在分析视图保持NULL，首帧/启动完成分开。Backend先兼容契约；分析表未迁移/启用前继续日志模式。

`lib/perf/drama-timing.ts` 管理列表/每次播放的单调时钟节点、查询和 HTTP 尝试；`drama-media.ts` 绑定本次 src 的事件/帧回调，`drama-observer.ts` 先用 createLogger 打印，再经 `lib/api/telemetry.ts` 的鉴权 POST 将报告集中写入 Railway；短剧专用 Sentry 上报已移除。上传 keepalive、background 优先级、总预算 5 秒且不重试，不参与播放结果；失败保留本地日志，不做离线补传。根 `PagePerfTracker` 管理入口与离开/后台监听。用户浏览时间独立于启动等待，预取与路由并行，不允许阶段简单相加。

`apiClient.onAttempt` 仅为可选的本地观测回调，包含排队、响应头与 body 解析，不能传入 fetch 或改变重试/超时。短剧 query 禁用 structural sharing，以保留结果对象与本次计时 WeakMap 的对应；不改变 query key、过期时间、请求去重或视频 URL 切换策略。播放器持有本次观察对象，旧组件更新不能重建/抢占导航目标的记录。成功必须同时有首帧与 playing；兼容降级明确标记，不能使用 canplay 代替。

每次等待 10 秒生成一次快照；失败、离开、后台等都生成终态，后台不计成慢播放。遥测异常不得影响请求/视频，地址/签名/对象路径不得进日志；上传契约按字段白名单和明细数量限制，禁止任意对象作为日志输入。关键回归及查询、发布、真机验收见 [排查说明](../../../../docs/drama-playback-timing.md)。

媒体启动诊断在原报告的可选 `media` 中记录最多 32 条有界事件，以及慢/终态时即时 `snapshot`。`play_called/play_resolved/play_rejected/loadeddata/canplay` 首次 marks 独立于事件截断；原 `playing + first_frame` 成功条件和手动/自动 play 的业务结果保持不变。不得逐帧记录 progress/timeupdate 或周期轮询。状态只含有限数值、布尔与枚举；bufferedAheadMs 只算覆盖当前位置的连续缓冲，读取失败为缺失，不得把远端缓冲、suspend 或零/缺失数据直接解释为网络根因。reader 在终态/媒体释放时解除，旧监听/Promise 不得写新流，慢快照不可被后续事件改写。通过既有 drama-media/observer/timing 测试验证，Backend 接受新契约后再发 Frontend。

内部固定样本实验另提供一次点击自动 AB/BA/AB：统一静音，首帧与 playing 后立即进行未缓冲 seek，失败保留并推进，组间400ms不计起播；后台停止、不自动补测。结束后自动回原路径，再用现有 telemetry API 提交 strict 脱敏报告，提交失败只重发结果。`packages/ui-tests` 的现有 dramas fixture 和 CDN 用例覆盖顺序、取址失败继续、回退/提交及窄屏；这些是虚构流程验证，不能替代 Telegram 真机性能。
