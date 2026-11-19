# 复用调研与可靠性审查

## 检索与选择

| 对象          | 现有位置                                                                                               | 决策与理由                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 冷入口/通知   | next.config.mjs; providers.tsx; early-startup.ts; startup-timing.ts                                    | 复用rewrite、early-ready、分波，根因分组后才动阻塞依赖                              |
| 请求队列/取消 | lib/api/client.ts; request-concurrency.ts; request-timing.ts                                           | 复用3总槽/normal保留槽/总期限；不加第二调度器                                       |
| 身份读取      | backend/src/lib/user.ts                                                                                | 已有60s/5000项不可变身份cache+singleflight，禁止重复缓存或绑定单个等待者取消        |
| 会话读取/降级 | routes/conversation-detail.ts; conversation-folders.ts                                                 | 复用现有phase、summary250ms、known503 fallback；只修确证关闭分类                    |
| 兼容UUID      | conversation-stream.ts:createConversationRequestId; lobby-recommendation-state.ts:createLobbyRequestId | 抽取既有算法，小helper复用；request-timing fallback不保证UUID，不能用于共享UUID DTO |
| 创作身份/草稿 | GetCreatorCharacterData.character.owner_user_id; use-character-editor-draft.ts                         | edit可直接复用detail owner；new保留认证list；不新增identity endpoint                |
| 创作统计      | creator-analytics.ts; creator/analytics-query.ts                                                       | 已有overview/面板按需和30s TTL；只凭慢页不建派生表、不改默认all                     |
| Faro有限投影  | api-timing.ts; grafana-schema.ts                                                                       | 补有限creator分组缺口；不把任意路径/ID放入标签                                      |
| 影像query     | image-plaza-feed.ts; CreationHub; client.ts:179                                                        | prefetch和页面共用key保留；修后台/分页默认critical，不重复加首屏critical            |
| TUS与任务     | video-delivery-job.ts; video-stream-upload.ts; VideoDeliveryRepository                                 | 一轮复用Buffer和逐块fence；不加缓存服务、队列或新表                                 |
| 数据库函数/列 | 20261117_media_plaza_stream_delivery.sql; docs/db/CONTRACT.md; registry.yaml                           | 保留claim/checkpoint/publish/fail和5m租约；新方案无新数据库对象/列/jsonb key        |
| 固定验收      | packages/ui-tests/README.md; roleplay.spec.ts; creator.spec.ts; image.spec.ts                          | 扩展现有fixture分组，不建一次性mock/浏览器脚本                                      |

## 故障模型

| 方面       | 设计判断                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 超时       | 沿用每个HTTP/SDK既有deadline；video一轮20s有控制器，原单调用期限后备；真正不合作传输不假装已结束 |
| 重试       | GET只沿既有安全有限策略；取消不重试。POST创建/扣费/发布未知结果不重发                            |
| 幂等       | 草稿/生成请求id跨重试保持；TUS通过HEAD offset裁决；publish/create未知保留原对账                  |
| 并发       | 请求/身份singleflight原样复用；video维持2并发，逐块fence；不在AbortSignal共享上取消其他等待者    |
| 事务       | 不改钱包、发布RPC的事务边界；持有既有lease再checkpoint；无新跨请求事务                           |
| 降级       | known503沿原flat fallback，unknown500保留。crypto缺失使用既有v4算法；媒体源未知不伪造成功        |
| 补偿       | 只用既有fail/publish/cleanup恢复；不新增退款流程，不把中断误当退款资格                           |
| 限流       | 不提高浏览器/worker并发、SDK请求量；背景预取不抢critical                                         |
| 容量       | 无新跨任务Buffer缓存；原源文件上限/2并发不变，每轮≤4块与20s预算；cold不全路由预取                |
| 可观测性   | Faro/Sentry/Pino现有出口，新增仅有限分组和最小安全摘要；业务ID不作为新标签                       |
| 恢复与回滚 | 各子任务独立提交、Backend兼容优先、灰度和新release48h；真实失败/权限/计费异常立即回滚该批        |
| 外部访问   | 只读Sentry/Grafana/Railway诊断；不读取数据库业务行，不新建服务/依赖，不自动部署或发布配置        |

## 拒绝的方案

不重复rewrite，不提前content-ready；不把启动SDK仅几毫秒当主因；不一刀切忽略AbortError；不以延长timeout掩盖慢请求；不为编辑器新增身份API；不全站持久缓存私有数据；不简单缩短租约、不对未知创建重试；不为四个样本承诺视频模型P95；不在没有计划证据时新建统计缓存表。

## 需在实现阶段继续验证的技术项

CDN响应头/构建关键依赖；CR真实cause与F4复现；受限视频drain中abort传播。均有明确停止/保留行为，不替用户更改产品边界。未验证不得宣称已修或已达到P95目标。
