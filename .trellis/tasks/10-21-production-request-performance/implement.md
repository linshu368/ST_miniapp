# 执行计划与验证门禁

状态：仅文档阶段，不授权生产操作。已按 2026-10-21 Sentry 采样重排后续批次。

主文档：`docs/production-request-performance-plan.md`（E18 = Sentry 证据）。

## 本轮交付

1. 只读规范/源码/依赖/版本/历史记录，标明证据等级。
2. 写规划及主文档，记录拓扑文档与源码差异，不擅改生产事实。
3. **纳入 Sentry MCP 生产 traces/issues 归纳**，映射到 L/N/S/C 与批次表。
4. 验证引用、无占位/秘密、JSON、Prettier、diff 和产品文件未改。
5. 保持 planning 等待审核，不运行 task start、commit 或 push。

本轮仅 Markdown/任务元数据，无受影响应用包；不新增测试、不启动服务/模型。应用 typecheck/test/build 本轮不运行，也不声称通过。后续代码实施必须运行适用检查。

## 设计交付（本轮，仍不实施）

详细优化设计见同目录 `design.md`（2026-10-21 源码回读锁定）。主文档 §9 为入口摘要。

设计已锁定的首选改法：

- P1-L-N1 → 大厅摘要补头像（方案 A）；会话内嵌摘要为方案 B
- P1-N-DETAIL → `loadLobbyFeaturedIdSet` 60s 快照 + 详情收窄 select
- P1-L-TAIL → favorites `id in`；列表 single-flight；badge 依赖 P1-C abort
- P1-S-HTTP → `getContextBeforeTurn` 单次 OR 查询
- P1-C → supabase `db.timeout` + 热路径 signal；Prisma 池另维

## 后续顺序（需批准；与 design.md §3 一致）

1. **P0-A** 固化 E18 对照 + 分段日志字段审核  
2. **P0-B**∥**P0-C** 有界等待 + 容量表（含 PostgREST）  
3. **P1-L-N1** 前端（可最先合入）  
4. **P1-N-DETAIL** + featured 快照（后端最大杠杆）  
5. **P1-L-TAIL** favorites 收窄 / 列表 single-flight  
6. **P1-S-HTTP** 合并 history 查询  
7. **P1-C** 超时/池参数（一次一维）  
8. **P1-A / P1-B / P1-N / P1-S**  
9. **P2 / P2-X**

每批：TEST 故障注入 → consumers → Preview/Telegram → 批准生产灰度；**改后用同一 Sentry 查询窗口对照 E18**；分别验收四主线，不把改快动画当作接口提速，不把 LLM 变短写成产品收益。`design.md` §7 门禁未勾选不得开始写产品代码。

## 测试范围审核

不在本轮创建测试文件。后续优先扩展现有测试；取消、额度、快照、advisory lease 清理属高风险，审核回归方案后实现，不能只测 happy path。

重点既有测试：

- `packages/frontend/src/lib/api/conversation-stream.test.ts`
- `packages/backend/src/features/conversations/generate.lifecycle.test.ts`
- `packages/backend/src/features/generation/execute.test.ts`
- `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.cancel.test.ts`
- `packages/backend/src/lib/postgres-advisory-lease.test.ts`

Sentry 驱动批次建议追加的人工/回归焦点（实施时再审是否落测试文件）：

- P1-L-N1：`/chats` 打开时 characters HTTP 次数上限与缓存命中。
- P1-L-TAIL / P1-N-DETAIL：列表/详情失败与超时出口；可见性不变。
- P1-S-HTTP：单轮 messages 对 `current_chat_history` 调用次数；计费/取消不变。

## 后续代码验证命令

integration 脚本须另行确认 TEST 目标及写入授权，不随下列本地验证自动执行：

```text
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm -r typecheck
pnpm -r --if-present build
pnpm lint:legacy
git diff --check
```

跨包/部署变更跑全消费者 typecheck 和适用 build；契约变更先 shared 测试。记录退出码与失败项，不把既有失败算通过。

生产对照（只读）：复跑 E18 同查询（http.server p95、pageload p95、Supabase >5s、三 Issue 事件量）。

## 人工与失败路径

- 大厅冷/热缓存、推荐/最新、返回定位、过期卡、空列表、离页/断网、headers/body 挂起、重试；**p50 正常但偶发 60s**。
- `/chats` N+1：列表项多时请求风暴、缓存命中后应收敛。
- 入口详情冷/热与预取未命中、新建/继续历史、POST 回填后请求次数、快速连点/离页、创建结果未知、非本人/已删会话、ready 后动画与 reduced motion、多端生成/streaming 恢复。
- AI 权限失败、同轮版本与读次数、预留不足/结果未知、取消/完成竞态、无正文/断流/缺 done、无重复扣款/额度泄漏；**区分 prepare vs provider vs consecutive history HTTP**。
- AI 首字后慢流、delta 已到但绘制慢、末正文后终态慢；相同模型与输入输出规模下记录正文完整性、流中停顿和终态时长。
- TEST 小池饱和、长事务、两副本 job、聚合失败/空结果、锁未获取、unlock 失败仍 close；区分停止等待与底层停止执行；**PostgREST 超时打满**。
- 连接建立半失败、work/cleanup 回调抛错、滚动发布重叠；同步检查其他 API 成功率与 p95，撤去负载后无需重启恢复；重试/排队不得持续放大。
- 真实模型/Telegram 批准后使用专用账户，明确环境和费用，不导出消息正文。

## 停止与回滚

权限/计费/取消异常立即停止。主文档候选性能阈值经审核后使用，结合失败率/样本量。回滚当前小批次代码或安全系统内旧参数；不关闭结算恢复，不回写账务，不把停止 timer 当终止在途事务。必要的新 migration 另审，附恢复方案。
