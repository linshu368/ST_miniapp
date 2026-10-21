# 执行计划与验证门禁

状态：仅文档阶段，不授权生产操作。

主文档：`d:/codeReposity/wq/ST_miniapp/docs/production-request-performance-plan.md`。

## 本轮交付

1. 只读规范/源码/版本/历史记录，标明证据等级。
2. 写规划及主文档，记录拓扑文档与源码差异，不擅改生产事实。
3. 验证引用、无占位/秘密、JSON、Prettier、diff 和产品文件未改。
4. 保持 planning 等待审核，不运行 task start、commit 或 push。

本轮仅 Markdown/任务元数据，无受影响应用包；不新增测试、不启动服务/模型。应用 typecheck/test/build 本轮不运行，也不声称通过。后续代码实施必须运行适用检查。

## 后续顺序（需批准）

1. P0-A 补四主线环境/版本/基线；被动日志优先，生产探测另行确认。记录 L 首载、N 新建/历史入口、S 首字/流速/终态、C 同窗口连接状态。
2. P0-C 先审全服务连接容量表、后台任务预算、异常释放和过载恢复方案；连接治理不再推迟到 P2。P0-B 同时规划大厅超时/取消/失败出口，独立批次便于回滚。
3. P1-N 进入会话：验证 POST 回填后的 GET 次数、ready 条件和开屏遮挡；先缩短非必要等待，再按证据调整窄范围 freshness/旁路读取。创建超时、结果未知和并发幂等方案未审不实现自动恢复写入。
4. P1-A 消息准备期只读快照复用，P1-B 大厅排名缓存刷新合并；先审一致性/陈旧窗口。P1-S 仅在流速/绘制/终态存在瓶颈时定点修改，不改变输出质量。
5. P1-C 按 P0-C 结论修正连接参数、后台调度和异常清理；不同时扩大池、并行度与副本。只有这些措施不足且证据指向具体查询/隔离/容量才做 P2。
6. 每批 TEST 故障注入 → consumers → Preview/Telegram → 批准生产灰度；分别验收四主线，不把改快动画当作接口提速。

## 测试范围审核

不在本轮创建测试文件。后续优先扩展现有测试；取消、额度、快照、advisory lease 清理属高风险，审核回归方案后实现，不能只测 happy path。

重点既有测试：

- `d:/codeReposity/wq/ST_miniapp/packages/frontend/src/lib/api/conversation-stream.test.ts`
- `d:/codeReposity/wq/ST_miniapp/packages/backend/src/features/conversations/generate.lifecycle.test.ts`
- `d:/codeReposity/wq/ST_miniapp/packages/backend/src/features/generation/execute.test.ts`
- `d:/codeReposity/wq/ST_miniapp/packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.cancel.test.ts`
- `d:/codeReposity/wq/ST_miniapp/packages/backend/src/lib/postgres-advisory-lease.test.ts`

## 后续代码验证命令

integration 脚本须另行确认 TEST 目标及写入授权，不随下列本地验证自动执行：

```text
pnpm --dir "d:/codeReposity/wq/ST_miniapp" --filter @miniapp/shared test
pnpm --dir "d:/codeReposity/wq/ST_miniapp" --filter @miniapp/backend typecheck
pnpm --dir "d:/codeReposity/wq/ST_miniapp" --filter @miniapp/backend test
pnpm --dir "d:/codeReposity/wq/ST_miniapp" --filter @miniapp/frontend typecheck
pnpm --dir "d:/codeReposity/wq/ST_miniapp" --filter @miniapp/frontend test
pnpm --dir "d:/codeReposity/wq/ST_miniapp" --filter @miniapp/frontend lint
pnpm --dir "d:/codeReposity/wq/ST_miniapp" --filter @miniapp/frontend build
pnpm --dir "d:/codeReposity/wq/ST_miniapp" -r typecheck
pnpm --dir "d:/codeReposity/wq/ST_miniapp" -r --if-present build
pnpm --dir "d:/codeReposity/wq/ST_miniapp" lint:legacy
git -C "d:/codeReposity/wq/ST_miniapp" diff --check
```

跨包/部署变更跑全消费者 typecheck 和适用 build；契约变更先 shared 测试。记录退出码与失败项，不把既有失败算通过。

## 人工与失败路径

- 大厅冷/热缓存、推荐/最新、返回定位、过期卡、空列表、离页/断网、headers/body 挂起、重试。
- 入口详情冷/热与预取未命中、新建/继续历史、POST 回填后请求次数、快速连点/离页、创建结果未知、非本人/已删会话、ready 后动画与 reduced motion、多端生成/streaming 恢复。
- AI 权限失败、同轮版本与读次数、预留不足/结果未知、取消/完成竞态、无正文/断流/缺 done、无重复扣款/额度泄漏。
- AI 首字后慢流、delta 已到但绘制慢、末正文后终态慢；相同模型与输入输出规模下记录正文完整性、流中停顿和终态时长。
- TEST 小池饱和、长事务、两副本 job、聚合失败/空结果、锁未获取、unlock 失败仍 close；区分停止等待与底层停止执行。
- 连接建立半失败、work/cleanup 回调抛错、滚动发布重叠；同步检查其他 API 成功率与 p95，撤去负载后无需重启恢复；重试/排队不得持续放大。
- 真实模型/Telegram 批准后使用专用账户，明确环境和费用，不导出消息正文。

## 停止与回滚

权限/计费/取消异常立即停止。主文档候选性能阈值经审核后使用，结合失败率/样本量。回滚当前小批次代码或安全系统内旧参数；不关闭结算恢复，不回写账务，不把停止 timer 当终止在途事务。必要的新 migration 另审，附恢复方案。
