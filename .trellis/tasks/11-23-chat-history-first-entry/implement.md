# 实施与验证计划

当前已获实施授权并运行task.py start。选择原有接口最小必要并行，不新建聚合RPC/migration。代码与自动化验证见verification.md；用户最新要求不启动本地UI。以下保留审核后的实施计划，尚未执行的TEST/生产步骤不标为通过。

## 开始实施前

1. 评审本任务PRD和设计，记录用户对最新方案的实施授权。重新读取当前HEAD、生产SHA、相关spec，保护已有工作区改动；本轮不自动切分支或修改其他任务。
2. 确认TEST/production目标后，仅采集获准的结构/权限/迁移账本证据，不读业务行；核对P5展示视图、角色版本RPC、名字字段、相关索引和服务角色权限。
3. 按design确认共享DTO、全部query/mutation consumer、取消定位、分页和ready口径；超长文件先按既有职责提取，不能继续增加基线超长函数。
4. 独立运行规划门禁，不用start测试门禁；启动实施后再按Trellis流程更新状态。

## T1：聚合读取

- 先按acceptance-and-observability.md核对职责清单，在隔离TEST建立同数据/并发的功能与负载对照。先确定聚合是否值得采用，不把“一次RPC”作为硬指标；候选变慢或负载恶化时缩小范围或最小并行读取，不部署业务大接口。

- 若对照证明聚合有收益，再写TEST可验证的新增shared migration，只提供有界的experience读RPC；原list_chat_message_page与HTTP响应兼容，禁止重写历史migration。选择必要并行方案时不为完成指标强建RPC。
- 复用分页函数与角色授权/版本RPC。内部数据只在repository内校验，名字解析、placeholder及DTO映射复用原helper；不加公共profile返回字段。
- 复用现有page retry的总预算，合并客户端/服务端最大尝试说明；离页取消不开始后续工作，共享身份解析不受单个调用方abort影响。
- 聚合分支不叠加Backend重试，单次RPC≤5秒、Backend总读≤8秒；Frontend最多一次允许的传输重试且总逻辑截止≤10秒。验证PostgREST取消效果，不把SDK abort当作SQL已停止。
- 扩展已有SQL回归：无权限/删除会话、空页、开场、分支、revision、编辑/删除/点赞、角色访问收回。安全、契约与迁移风险要求回归锁定，优先扩展现有测试文件。
- 只有TEST shape/ACL/读性能和兼容性通过，才准备生产人工迁移审核。当前任务交付不执行该步骤。

## T2：历史先显示

- 现有GET显式limit=20，分页默认保持原约定；所有首屏/刷新/streaming consumer一致，原query key不增加用途分叉。
- 保留创建响应缓存、取消定位、已加载页、编辑版本与滚动锚点；可选内容在历史commit后按原entry阶段加载。
- 不扩大私人缓存TTL和范围。只有必须扩大时，先完成可信viewer隔离与换号清理，不能使用Telegram ID冒充内部owner。
- 扩展已有@chat/@chat-history固定fixture：慢模型/设置但历史已可读、最近10轮及200轮向上翻完、旧响应迟到、快速切会话、已编辑/删除/点赞/分支和新建免重复GET。

## T3：恢复覆盖与读写分离

- 独立调整现有sync任务的stale来源窗口，不改变账务/元数据24小时窗口或结算规则。验证有限批量、索引计划、失败公平退避、跨副本与重启。
- 验证24小时以前孤儿、无charge与有charge、失败重试、活跃生成不被抢占、先释放预留再解锁。不得新增永久业务列、后台无界任务或内存幂等代替DB。
- 覆盖通过后才移除GET恢复；发送/重生成startTurn前的恢复/权限/报价/额度门禁保留。失败则停止T3，T1/T2保留旧恢复依赖独立发布。

## T4：Railway故障治理

- 先按acceptance-and-observability.md确定字段语义和白名单贯通；正常entry成功采样10%、正常poll无额外摘要，失败/慢读/重试/未知结果全量，一请求最多一个业务读摘要，根HTTP终态继续保留成功分母。
- 在现有logger真实stdout/serializer测试中验证新字段、中文展示、固定原因、原始错误脱敏、完成守卫和采样；SQL内部阶段未测到时不能伪造owner/settings/opening耗时。不为日志增加SQL、重新序列化正文或读取响应流。

- 扩展现有EventFields及统一安全投影，验证phase/固定reason/资源分类确实出现在stdout与Railway，继续使用{err}。
- 回归PT409交付冲突：主备竞争、取消先到、交付选择先到、重复同attempt、真正不一致。未确认交付不结算，永久冲突不重试。
- 回归DB终态写入5秒超时、结果未知、sync重试与进程重启；只收口一次，不自动重发付费POST，不丢部分正文。
- 第一token截止、用户主动停止、读取连接断开、DB timeout/上游网络断开保持不同原因；只有有权威证据的正常停止才降级日志。
- 核对既有记忆压缩优化的发布状态与79次too_long/1次timeout，保留旧记忆。未证实首屏容量关联前不扩大重构范围。

## 现有验证命令（实施后执行，本次尚未运行）

```powershell
pnpm --filter @miniapp/backend exec vitest run src/routes/conversation-detail.test.ts src/infrastructure/repositories/conversation-page-retry.test.ts src/infrastructure/repositories/conversation-history-postprocess.test.ts src/features/conversations/active-delivery.test.ts src/features/conversations/user-placeholder.test.ts src/infrastructure/repositories/effective-display-name.test.ts
pnpm --filter @miniapp/frontend exec vitest run src/lib/api/conversations-entry.test.ts src/lib/api/conversation-stream.test.ts src/lib/perf/page-tracker.test.ts
pnpm --filter @miniapp/backend exec vitest run src/features/generation/sync-job.test.ts src/features/generation/apply-charge.test.ts src/features/conversations/generate.lifecycle.test.ts
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
pnpm lint:complexity
pnpm lint:backend-logging
pnpm --filter @miniapp/backend logging:validate
pnpm lint:migrations
pnpm lint:db-contract
pnpm --filter @miniapp/frontend build
pnpm test:ui --grep '@chat'
```

SQL验证扩展并运行现有 `packages/shared/migrations/tests/chat_history_display.sql`、`chat_history_display_performance.sql`、`creator_characters.sql`，使用仓库既定的隔离数据库/PG17/PostgREST测试入口；执行前确认可用运行器与目标，不临时连接共享TEST执行写入。并发、真实Provider/账务及Telegram双端另作人工验收，不能拿WASM单连接或UI fixture代替。

适用的日志stdout/安全出口现有测试一并执行；实际改到哪个observability模块，就运行相应回归，不能只运行业务mock。跨包变更运行全部consumer typecheck与适用build。复杂度拆分后运行 `node scripts/complexity-budget.mjs update` 收紧基线，不扩大预算。

## 发布与恢复检查单

- TEST与production分别记录前后shape、ACL、migration checksum/账本、锁/语句超时及容量证据；未知前置形状拒绝执行。
- 保留旧客户端默认和旧应用兼容。迁移只新增兼容函数，旧应用回滚不依赖删函数。
- 确认部署SHA后再采样；按Android/iOS、release、页面、导航类型和请求用途分组，稳定48小时后计算P95及N，同时核对失败/离页/stall和恢复积压。
- 上线前取得生成终态成功分母与按请求去重规则，才计算真实错误率；本次1096行error不是失败分母。
- 任一越权/历史缺失/账务不一致立即停止，保留证据、回退兼容应用；统计退化遵循design阈值并人工核实，不自动生产写入。

## 本次仅规划验证命令

```powershell
python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-23-chat-history-first-entry
pnpm exec prettier --check '.trellis/tasks/11-23-chat-history-first-entry/*.md' '.trellis/tasks/11-23-chat-history-first-entry/task.json'
git diff --check
git status --short
```

另以Python直接调用 `validate_module_impact`、`validate_mobile_performance`、`validate_logging_integration`，不调用start、不变更活动指针。文档规划检查不代表运行代码或生产P95已验证。
