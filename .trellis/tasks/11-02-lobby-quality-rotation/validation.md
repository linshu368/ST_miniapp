# 本地验证与交付边界

工作区 codex/lobby-score-qualified-users，base main b54ea341；复用已完成资历校准。无commit/push/远端迁移/配置发布。

已完成：规划独立审核、SQL/算法/CAS/运营/前端跨层审核；修复90天旧成熟证据、重放不覆盖后续validator、ACL保留、撤回失效误报、公共目录缺头部资料跳动。

已通过：全消费者typecheck；Backend 117文件1220测试（后补4路由用例由固定命令验证）；Frontend67文件726测试；Shared18文件229测试；Admin14文件137测试与build；Frontend build；legacy/migration guard。固定评分与轮换85通过、1可选40万容量场景未重复执行；本地PG17使用实际生产SQL、迁移重复、旧/后续validator保留、ACL、独立连接并发。UI @roleplay完整20通过；冻结后的最终@lobby-rotation专项11通过，包含320/390宽度、缓存缺项等待、刷新失败保旧、撤回过期、账号隔离及24小时边界。fixture类型检查及8项契约测试通过；最后的Frontend生产构建通过。

早期UI因开发HMR重挂产生varuire/请求ID变化，代码冻结后完整20项通过；没有为开发热更新增加生产机制。fixture和PG互补，虚构数据不代表线上推荐效果；尚未真实灰度、新策略开关仍默认关闭。

灰度发布前：逐环境迁移→Backend→qualified-v1成功刷新→Frontend/Admin→运营开关/比例。观察前12重复比例/实际曝光不同卡，以及成熟用户新角色10轮转化（完整历史口径，不能用分页会话推断）；生成/曝光日志已有数量摘要，业务效果需发布后真实数据评估，不把模拟验证当效果结论。

本地交付预览：http://127.0.0.1:4800/characters；场景lobby-rotation，36张虚构卡片；验收控制台http://127.0.0.1:4801。复用现有preview:ui与ui:test，无独立测试环境。模块更新载荷已由独立代理审核通过。

## 发布前适配（用户已授权上线）

2026-11-02同步最新origin/main 7a9ddf27，保留同事的移动端性能与模型供应商优化；仅将换批/撤回的首屏挂载数接到既有listBudget。全包typecheck、lint、legacy/migration guard及diff检查通过；实际PG/评分轮换85项通过（1可选容量场景不重复），合并后完整移动端@roleplay 23项通过。生产结构只读确认所需根表与配置校验器存在。待远端CI、TEST/production迁移和按dev→独立main流程发布；轮换先10%灰度，24小时。
