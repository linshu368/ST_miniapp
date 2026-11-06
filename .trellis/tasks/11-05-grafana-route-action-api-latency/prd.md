# Grafana 页面按钮与接口耗时看板

## Goal

在现有 Grafana 工程看板中增加二级页面、三级页面、按钮、普通 API 与 SSE 接口耗时视图，Android/iOS 分列并以 2 秒为目标，复用现有遥测且不影响业务性能。

## Requirements

- 在现有 Grafana 工程观测体系中新增五份可导入 dashboard source，分别覆盖：二级页面路由、三级页面路由、关键按钮反馈、非流式 API、SSE/流式 API。
- 一级入口固定为 `/watch`、`/dramas`、`/characters`、`/creation`、`/profile`；下属路由使用审核后的有限映射，不根据 URL 动态生成标签，不暴露用户、会话、订单、角色或消息 ID。
- 页面主指标使用站内导航起点到真实主内容 ready 的 `page.navigation`；冷打开/直接打开只作为 `page.launch` 辅助视图，不与 SPA 导航 P95 混算。
- 每份 dashboard 必须按 `tg_platform` 区分 Android（`android|android_x`）和 iOS（`ios`），同时保留 environment、release 与时间窗口筛选。
- 页面、关键按钮、普通接口响应与 SSE 首个可见事件的目标 P95 均为 2000ms；图中显示 2 秒阈值、2 秒内占比、P95、有效样本量及失败/离页/卡住等终态，不能只展示成功幸存者。
- “按钮”限定为会触发网络请求或跨路由等待的关键业务动作。复用现有 `startAction` owner；禁止全局 DOM click 监听、按钮文案标签或逐帧观察。纯本地展开、关闭、切 tab、播放手势等瞬时交互不纳入本 dashboard，专用短剧指标继续留在原看板。
- 现有关键动作至少覆盖 `select_character`、`send_message`、`recharge_create_order`、`vip_create_order`、`daily_checkin`、`support_send_message`、`image_generate`、`voice_generate`、`create_conversation`；按动作发起时的安全 route template 和 canonical entry 聚合。
- 普通 API dashboard 覆盖 Fastify 已观测 route，但排除所有长连接/流式响应；不得仅依赖现有 `kind=standard` 而误删非 SSE 生成接口，或把 NDJSON 完整流时长混入 2 秒普通接口目标。
- SSE dashboard 至少分别展示 `POST /api/v1/conversations/:id/messages` 与 `POST /api/v1/conversations/:id/regenerate` 的客户端首个可见 token、服务端完整流时长和终态；`POST /api/creator/polish` 是 NDJSON 而非 SSE，放在同一流式排障 dashboard 的独立区域并明确协议。
- SSE/NDJSON 的 2 秒目标只适用于 headers/首个可见正文或 token；完整回复/完整流耗时只作容量与长尾诊断，不设置错误的 2 秒 SLO。
- 优先复用 `page.*`、`roleplay.*`、`api.*`、`creator.polish.*`、`st_http_server_duration_seconds` 现有数据；只有按钮缺少 Grafana 投影时，才扩展现有 action tracker 的安全镜像。
- 观测不得改变业务请求数量、请求顺序、React Query 缓存、SSE 读取、超时、重试、页面 ready owner 或按钮反馈时机；Exporter 未配置、队列满、加载失败或发送失败时必须直接降级丢弃。
- dashboard 默认查询窗口/刷新频率保持有界，避免高频长窗口 LogQL/PromQL 对 Grafana/Loki/Mimir 造成额外负载。
- 仓库 JSON 可导入不等于 Grafana Cloud 已更新；若缺写权限，只交付源文件、导入说明和待线上验证项，不宣称生产看板已生效。

## Acceptance Criteria

- [ ] 五份 dashboard JSON 均可解析、UID 唯一、数据源/变量与现有工程看板兼容。
- [ ] 二级与三级页面 dashboard 按 canonical entry、route、Android/iOS 展示 P95、≤2秒比例、N、终态/卡住；无样本显示 no data，不补 0ms。
- [ ] 关键按钮 dashboard 能覆盖九个既有关键动作，并按入口、发起页面、动作、Android/iOS 排查；旧 release 的硬编码 route 不与新 release 混算。
- [ ] 非流式 API dashboard 明确排除 SSE 与 NDJSON 长连接，按 route/method/platform 展示客户端总等待和服务端耗时；两个来源不可相加或相减独立 P95。
- [ ] SSE/流式 dashboard 分别展示 send、regenerate 与 creator polish，区分首个可见事件和完整流耗时；2 秒目标不套到完整生成。
- [ ] 所有主图都有 2000ms 阈值、样本量与失败分母，Android/iOS 可单选也可并列，不把 unknown/desktop 混入移动端达标结论。
- [ ] 运行时改动不新增业务 fetch、全局点击监听、轮询、数据库对象、SDK 或依赖；遥测异常不影响按钮、页面、API 或 SSE 成功/失败结果。
- [ ] 复用现有测试文件验证 action route/entry 低基数与异常隔离；完成 Frontend typecheck/test/lint/build、dashboard JSON/查询静态检查及适用 complexity 检查。
- [ ] 最终文档记录路由层级、协议边界、P95 口径、历史基线、发布后两个 24h 窗口验证和回滚入口。

## Android/iOS 性能 P95 门禁

- 受影响页面：五入口下属的固定二/三级 route template；运行时只扩展既有关键 action 的 Grafana 镜像，不改变页面加载 owner。
- 受影响接口：所有已观测非流式 Fastify route；聊天 send/regenerate SSE；creator polish NDJSON。
- Android 页面加载 P95：已知 `/chat/:id` 2392ms（N=135）/ 各路由目标 2000ms；其余二/三级页面缺同窗口可靠基线，不补零。
- iOS 页面加载 P95：已知 `/chat/:id` 3362ms（N=31，低样本）/ 各路由目标 2000ms；其余二/三级页面缺同窗口可靠基线，不补零。
- 接口 P95：普通 API 历史最高可见约 Android 3704.15ms、iOS 3857.6ms；聊天首字 Android 4536ms、iOS 5002ms；响应阶段目标 2000ms，完整流不适用 2 秒目标。
- 数据来源与观测窗口：历史 Grafana Cloud Loki `production/engineering_v1` 任务记录；普通 API 为 2026-10-27 至 2026-11-03 7d，页面/聊天为 2026-11-04 最近可复用记录。新 route/action 维度必须按发布 release 重建基线。
- 发布后验证、无可见样本/低样本及不适用说明：连续两个完整 24h 窗口，按 release + route/action + Android/iOS；单组 N<100 延长观察。成功、失败、离页、stall、采集健康共同检查；无样本不解释为 0ms。观测变更自身不得造成同口径业务 P95 超过 5% 回退。

规划完成后同步填写 `task.json.meta.mobile_performance`：有影响使用 `required`，确实不影响移动端页面加载和接口性能时使用 `not_applicable` 并填写具体理由。门禁未完成时 `task.py start` 会阻断。

## Notes

- “各个按钮”按关键网络业务动作解释；全量自动采集所有 DOM button 会引入噪声、高基数和额外主线程工作，违反本任务性能约束，因此明确排除。
- 2 秒是目标线，不是当前已达成事实；dashboard 只能暴露与定位慢点，不能凭新增面板宣称性能已经优化。
