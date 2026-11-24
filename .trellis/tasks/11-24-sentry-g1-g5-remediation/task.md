# G1—G5执行状态与证据链（v3）

2026-11-24，用户已授权本地修复/诊断/稳定性补强，任务已start。代码已完成；Frontend构建因内存不足未验收，保持in_progress，不视为生产问题全部完成。用户明确不做本地UI测试，后续未执行。详细设计见[实施计划](research/implementation-plan-v3.md)，技术结果见[实现记录](research/implementation-result-v3.md)，当前检查见[验证记录](verification.md)。

| ID  | 状态         | 结果 / 剩余动作                                                           |
| --- | ------------ | ------------------------------------------------------------------------- |
| P01 | 完成         | 最新HEAD/dev、全5组原窗、既有任务与实际commit去重，复核v2留档             |
| P02 | 完成         | 用户批准后收敛v3，mobile/logging/module声明；start成功                    |
| I01 | 完成         | G1显式初始化阶段、安全失败日志及原Errors状态上下文                        |
| I02 | 完成         | G2布局快照及封面合帧/同值保护；原observer原因仍待核实                     |
| I03 | 完成         | G3调用方实际取消分类、独立失败保留、QueryObserver/body失败关联            |
| I04 | 完成         | G4已复现局部idle缓存/messageerror后修复，提交原文降级warning              |
| I05 | 完成         | G5分段业务回执诊断，不改SQL/3秒/计费；DB等待原因和终态仍待核实            |
| T01 | 完成         | 7项退役renderer测试迁移，保护安全/choices/details及旧块隐藏               |
| V01 | 相关检查通过 | 全consumer typecheck、相关回归/全renderer/shared、适用静态检查及Admin构建 |
| V02 | 未通过       | Frontend构建两次内存不足，须在资源充足环境重跑构建；禁止标发布就绪        |
| V03 | 用户排除     | 不做本地UI；此前服务启动失败尝试不作为产品断言结果，新重复场景未执行      |
| D01 | 完成         | 当前repair-report模板v3、实现/验证/模块更新载荷及Issue证据链              |
| H01 | 未执行       | 真实宿主/CDN/生产receipt与账务/双端有效P95，按既有授权边界处理            |

## Issue→改动→commit/PR→部署→验证

所有路径从仓库根解析。本次没有Git暂存/提交/推送、合并、部署、生产配置/迁移/供应商/计费或Sentry状态写操作。

| Issue              | 本次改动                                                                                                   | 本次commit / PR | 本次部署 | 验证 / 剩余缺口                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | --------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| G1 / ST-MINIAPP-2  | frontend lib/telegram/init.ts、sentry/diagnostic-state.ts、error-diagnostics.ts及instrumentation-client.ts | 无，未提交      | 无       | SDK4项/诊断5项与typecheck通过；真实native时序未知，不保证线上恢复                                            |
| G2 / ST-MINIAPP-6D | character-cover-viewer.tsx、character-cover-gestures.ts及安全布局上下文                                    | 无，未提交      | 无       | typecheck/lint/复杂度通过；UI排除，具体observer及点击/滚动影响未知                                           |
| G3 / ST-MINIAPP-7Z | frontend api/client.ts、perf/request-timing.ts、first-token-reports.ts及诊断                               | 无，未提交      | 无       | 调用方取消/独立网络/期限/QueryObserver-body迟到失败相关测试通过；原Errors owner/保存终态未知                 |
| G4 / ST-MINIAPP-34 | reply-renderer scheduler/ReplyRenderer/types；chat-message-bubble及reply-diagnostics                       | 无，未提交      | 无       | renderer35项、实际bubble consumer相关2项通过；构造失败等单测通过，新增UI场景未执行；历史资源及同操作恢复未知 |
| G5 / ST-MINIAPP-CE | backend routes/conversation-interactions.ts、conversation-receipt-diagnostics.ts；真实Pino输出回归         | 无，未提交      | 无       | Backend相关66项、客户端恢复相关测试通过；原RPC取消原因、receipt最终态与资金影响未知                          |

历史保护和退役契约commit见[复核记录](research/review-2026-11-24-v2.md)，不得当作本次修复commit。三个11-19任务仍review，11-02任务仍in_progress；不代其关闭。初期记录提到用户暂存报告，当前只读核查index为空；未自行改变暂存状态，原报告/v1/v2保留，新增v3。

## 下一周期与处置

互斥结论：必须处理2（G4/G5）、待核实3（G1/G2/G3）、可暂缓0；本地观测/稳定性改动不改变原窗业务结论。专项G5需分段证据、原DB等待/回执最终态和并发/账务验收，单点改超时不充分。

先完成Frontend构建→G5同receipt/DB与G4真实资源/继续聊天→G1宿主、G3离页/保存→G2循环定位。建议责任岗位：G5聊天/计费、G4渲染/发布、G1启动、G3创作/API最晚11月24日15:30 +08给补证/止损安排；G2大厅11月25日12:00 +08复查；G5阶段验收11月25日18:00 +08。具体接手人未确认，不能当已接受承诺。

真实资金/身份/隐私/数据异常立即停止扩发并安排止损；白屏、消息不可读、导航或保存受阻升级必须处理。没有影响可接受证据，不列暂缓；线上新日志缺报、原故障无同操作终态、有效N不足时继续待核实，不用其他成功请求替代恢复。Android/iOS P95基线null，按design分指标48—72h补有效N和采集健康。
