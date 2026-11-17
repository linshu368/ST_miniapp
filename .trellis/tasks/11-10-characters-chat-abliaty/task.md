> 2026-11-11 最新澄清：仅取消后续开发强制本地性能实测，原有规划/质量门禁与本任务验收保留；11-11任务暂停。本任务完成度见 [复核报告](research/completion-review.md)，当前仍未整体完成。

> 2026-11-11 用户已批准实施。实现与检查结果见 [验收记录](research/implementation-validation.md)；全部硬门槛通过后自动归档，当前仍在验收。

# 可执行任务

新增 B2/B3 与原任务一起实施，V1/D1 同时覆盖；P2 已完成，任务已 start。本地实现不等于正式环境迁移或生产发布。

2026-11-11用户确认R10/AC17-20为硬门槛：不拖慢打开/操作、完整记录零缺失、阅读体验不退化、正常回复和其他功能不回退。以此判定B3/V1/C1完成，不接受仅SQL达标。

| ID  | 状态              | 内容                                    | 文件范围                                                                                         | 依赖/验证                                         |
| --- | ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| P1  | done              | 根因/源码/复用及可靠性调研              | research/, prd/design/implement/task                                                             | 审计证据核对                                      |
| P2  | done              | 用户审核最新规划，随后start             | task.json                                                                                        | 不以原始修复请求代替本次规划审核                  |
| F1  | implemented_local | 兼容查找与引导按需加载                  | onboarding/chat-guide.tsx, chat/chat-message-list.tsx及必要测试                                  | P2；缺findLast回归                                |
| F2  | implemented_local | 根错误重载与身份捕获/401提示            | global-error.tsx, telegram/auth.ts, hooks/use-chat-session.ts及必要helper                        | P2；合法身份/缺身份/重载/不重复写                 |
| F3  | implemented_local | 目录总截止、慢成功及缓存降级            | api/characters.ts, perf/request-timing.ts, mobile-performance.ts；必要时lobby-recommendations.ts | P2；取消/排队/body/排序                           |
| B1  | implemented_local | 抽取历史分页与GET编排、只读短恢复及诊断 | ConversationHistoryRepository.ts, 专用读取模块, conversations.ts, 专用GET编排                    | P2/B3；owner在先/最多2次读取/总8秒/DB慢查询不重试 |
| F4  | implemented_local | 有证据的首屏非关键依赖后移              | providers/PagePerfTracker等必要边界                                                              | F1/F3；构建对比，媒体计时起点不变                 |
| V1  | partial           | 扩展现有UI/单元/SQL失败恢复与长历史回归 | ui-tests既有fixture及chat/roleplay/startup、相关Vitest、PG17 harness                             | F1-F4/B1-B3；消费者typecheck+build+lint           |
| D1  | implemented_local | 更新模块spec、性能验证与回滚说明        | frontend/backend相关module，必要README/architecture                                              | V1；不宣称已上线                                  |
| C1  | review_delivered  | 交付本地完成度复核与检查报告            | task报告                                                                                         | D1；不自动commit/push/deploy                      |

## B2：CORS预检与拒绝分类（本地实现，部署配置待应用）

- 前置：P2，具体证据见research/cors-preflight.md。
- 文件：backend/src/app.ts、专用CORS注册helper及必要测试；复用shared/src/api/envelope.ts；README/ARCHITECTURE与Backend环境spec。
- 行为：固定正式Vercel域名及既有合法Frontend/Admin预检204；新增可选精确来源配置与规范化，不改支付回跳用途；真正未授权Origin的OPTIONS/实际请求403且不执行业务，保留无Origin和开发/TEST/PR行为，不开放Vercel通配。部署配置差异单列待授权。
- 诊断：结构化受控拒绝日志，保留真实服务错误；审查可定位自动化目标，未知仓外调用方不猜测。
- 验证：Fastify.inject环境/来源/方法矩阵、无身份实际API鉴权、真实异常仍500、日志安全；Backend/shared测试、consumer typecheck和build；发布后分开观察204/403/真正5xx。

## B3：长会话历史与prompt解压（本地实现，性能硬门槛未通过）

按research/history-combined-design.md合并实施，原复核保留证据：窄键分页、完整展示投影、真实原子writer、旧writer失效及历史回填均属本次；不再把只读阶段作为最终设计，也不建立解析存量prompt的trigger。AC14覆盖最早页，R10/AC17-20不变。

| ID    | 状态              | 可执行内容                                                                                          | 依赖/验证                                                                          |
| ----- | ----------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| B3.0  | done              | Sentry/Railway同故障关联；确认production Supabase并只读采集view/index/ACL/TOAST结构；机制查PG17源码 | research/history-read-performance.md；未读取业务行，未运行性能实验                 |
| B3.1  | partial           | 虚构数据普通列/单JSON元素/两元素/完整快照/标量投影对照；原表与宽视图分别测                          | 官方便携 PG17.11 隔离集群已运行，完整矩阵待补齐；见验收记录                        |
| B3.2  | implemented_local | 小投影表、仅失效trigger、真实admission RPC原子投影及只读分页RPC                                     | B3.1；域/权限/有效输入guard/精确request字符串/旧writer/重放及原写回滚              |
| B3.3  | implemented_local | 有限回填、跳过锁重访与全历史覆盖；缺失/失效同语句fallback及断点恢复                                 | B3.2；起始<=100行/3秒/500ms锁；不UPDATE history，不建100行一个永久文件             |
| B3.4  | implemented_local | index选逻辑turn/最大revision/继承遮蔽，再取该页展示overlay；repository组装复用原DTO                 | B3.2；单语句快照、has_more、request_id、开场白、preview、编辑/删除/点赞等价        |
| B3.5  | partial           | 已运行 10/100/1000/10000 轮与索引计划；末轮增长比例及写准备不退化门槛未通过                         | B3.3/B3.4；SQL<=200ms、10000/100轮<=2倍、本地GET<=500ms；不达标先优化而非加timeout |
| B3.6  | validated_local   | 本地 UI/单元/SQL 回归；62 项 UI 由全量与针对性复验联合覆盖，不等于真机与正式 TEST                   | B3.4/B1；DTO不变、权限/取消/并发/迁移失败回归                                      |
| B3.7  | partial           | 两份TEST迁移已执行并预检；业务覆盖与生产灰度待完成                                                  | B3.5/B3.6/B3.8/B3.9/B3.10；缺失基线NULL，本轮不远端写入                            |
| B3.8  | pending           | AC17-20硬门槛验收：新旧打开/回复/写入性能对照、全分页零缺失与阅读位置/草稿/现有功能矩阵             | B3.5/B3.6；缺样本不判通过，确认退化停止切换；不以20%告警阈值放宽用户约束           |
| B3.9  | implemented_local | recover/require/finalize/context/cancel字段审计，消除无必要快照读取；测session-stats与连接/网络     | B3.1/B3.2；真实上下文/恢复/计费不变，未达标相关路径不能结项                        |
| B3.10 | implemented_local | 演练读回退及DB写维护恢复；覆盖回退、旧writer再写、失败回滚验证                                      | B3.2/B3.3/B3.9；仅退Backend不能代替DB写恢复                                        |
