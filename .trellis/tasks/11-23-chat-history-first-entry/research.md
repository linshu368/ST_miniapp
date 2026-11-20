# 复用调研与来源

本次只读分析，没有查询Supabase业务行，没有执行SQL、修改环境、部署或通知他人。

| 来源/位置                                                                                        | 结论与取舍                                                                                      |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| README.md、docs/ARCHITECTURE.md                                                                  | pnpm多包、HTTP跨应用；历史候选说明不等于部署记录                                                |
| frontend/app/api-dataflow-and-state.md、conversation-ui模块规范                                  | React Query为服务器状态唯一入口；分支/版本/编辑/分页不得退化                                    |
| backend/app/data-reliability-and-security.md、logging-integration-planning.md                    | Pino/ALS、白名单与一次终态；unknown写结果不得重放                                               |
| shared/contracts/index.md及api-contracts.md                                                      | 公共契约先shared，旧字段语义兼容                                                                |
| docs/db/CONTRACT.md、registry.yaml、database/supabase/index.md                                   | experience归属；chat_history moving不加列；独立TEST/production手工迁移                          |
| frontend/app/chat/[characterId]/page.tsx、hooks/use-chat-session.ts                              | ready依赖详情成功；已有数据可立即显示，不虚构ready优化；page超长需职责提取                      |
| frontend/lib/api/conversations.ts、conversations-entry.test.ts                                   | 复用详情/创建缓存/分页/取消定位，默认50消息可显式limit=20；key只有sessionId，不扩大私人缓存范围 |
| frontend/components/chat/chat-splash.tsx                                                         | 3000ms是假进度曲线，不是固定等待3秒；不以改动画替代依赖优化                                     |
| frontend/lib/entry-phase.ts、navigation-quiet-window.ts                                          | 已有critical/enrich/background与Android安静窗，复用调度，不增建第二套                           |
| frontend/components/chat/chat-message-list.tsx、reply-renderer                                   | 先减首屏数量，不凭无CPU剖面的推测引入虚拟化                                                     |
| backend/routes/conversation-detail.ts                                                            | 三组串行读取与组内并行；已有精确离页取消判定必须保留                                            |
| backend/lib/user.ts                                                                              | 身份TTL60s/单飞只存不可变映射，复用；不加入可变昵称                                             |
| repositories/UserProfileRepository.ts、effective-display-name.ts                                 | 昵称当前每次GET；聚合读后复用既有回退优先级，不缓存可变字段                                     |
| repositories/ChatSessionRepository.ts                                                            | 归属检查、角色运行版本、title映射必须保留                                                       |
| repositories/conversation-history-reads.ts、conversation-page-retry.ts                           | 有界读取、版本唯一、cursor排序、展示开场、有限暂态重试全部复用                                  |
| features/conversations/user-placeholder.ts、active-delivery.ts                                   | 昵称替换与带版本原文分工；内存流仅已授权同user/session/revision可叠加                           |
| features/conversations/turn-preparation.ts、ConversationHistoryRepository.ts                     | startTurn前恢复是额度/并发门禁；GET移除恢复前必须有可靠覆盖                                     |
| features/generation/sync-job.ts、sync-record-recovery.ts、conversation-history-billing.ts        | 30秒既有任务含stale来源但有24小时下界；扩展这一来源，不再建任务系统                             |
| migrations/20261119_db_reorg_p5_chat_history_contract.sql                                        | 最新仓库分页函数复用展示投影/分支/编辑/点赞；不等于远端已经执行                                 |
| migrations/20261030_creator_character_versions.sql、20261118_db_reorg_p3c_character_listings.sql | 角色访问、版本绑定与开场规则，不能因首屏不展示开场就省略权限                                    |
| migrations/20261026_first_token_nonretryable_conflicts.sql、20261028_first_token_race.sql        | PT409是不可重试冲突，不改回40001，不自动放宽CAS                                                 |
| generation-stream.ts、generation-runtime.ts、GenerationObservationRepository.ts、settle.ts       | AbortError可能来自截止/取消/失败，交付未确认不结算，账务未知走幂等对账                          |
| packages/ui-tests/README.md、migrations/tests/chat_history_display\*.sql                         | 复用200轮/旧WebView/分支/权限回归；fixture不是生产双端P95或真实账务证据                         |

性能研究沿用前一任务的Grafana、Railway、Sentry证据。本轮Railway错误独立采集，4片均少于500行上限，保存字段投影后的1096条error、16条详情warn及6条相关请求查询。图表/P95仍来自原48小时，不将错误查询结果当作性能分位样本。

官方文档通过Supabase search_docs只读核对Database functions：默认invoker、definer要限制search_path、EXECUTE必须显式收紧；未使用MCP读取业务行。具体对象归属与迁移入口以仓库更严格规范为准。

## 有意推迟、实施前必须解决的技术验证

- TEST与production的函数/视图/ACL/索引及迁移账本前置形状；未确认目标前不做MCP采集。
- 不限24小时的stale扫描真实查询计划、容量、公平推进与跨副本幂等；不过关时T3不能上线，可独立交付T1/T2。
- 5次PT409对应的精确守卫；目前只能确认交付选择409，不将安全屏蔽的错误文本推测为某个确定原因。
- 聚合RPC是否取得预期收益：一个网络往返仍包含内部查询；真实SQL/HTTP/body/渲染要分层测量。
- 当前本地HEAD与生产SHA后续变化；实施前重读现行文件，尤其免费额度和结算，不改写上游行为。

## 本轮补充核查

重新核对conversation-detail.ts、conversation-page-retry.ts与observability/events.ts、safe-log.ts、logger-options.ts：嵌套phases与未登记phase会在日志出口被过滤；普通Pino的数字后缀投影和EventFields的白名单不是同一层，单改调用点不能保证Railway可见。既有DB fetch只量到响应头，聚合后不能从外层计时伪造SQL内部阶段。新增验收文件固定聚合范围、对照条件、字段语义、次数/截止和功能矩阵，不增加产品实现。
