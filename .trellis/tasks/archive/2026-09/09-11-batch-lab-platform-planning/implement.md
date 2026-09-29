# 实施计划

> 当前任务只交付规划，保持 `planning`。人工评审 PRD/design 并明确同意实施后，才运行 `task.py start`。建议按下面阶段实施；每阶段均可独立停止，不将未完成能力伪装上线。

## 阶段 0：开工核对与实况

1. 核对 test 的会话/turn/revision、角色卡、历史 prompt、动态记忆和模型配置 shape；只读，不导出业务行。
2. 明确首批 SQL 模板业务口径、锚点字段和最大样本/X/SQL/输出/导出容量。
3. 评审 generation 内部免用户计费策略、正则隔离方案和来源环境专用只读连接；V1 不设计登录、生产合规、脱敏或审批流程。
4. 建立原型控件→PRD→任务映射清单，确认备注/标签是否后置。

**门禁**：无法保证只读 SQL、免钱包/真实会话写入、环境指纹或 A/B 快照一致时停止。

## 阶段 1：Shared 契约与 Batch Lab 应用骨架

1. 定义 `batch-lab.ts` DTO/Zod：context、模板/preview/sample set、processor、experiment/config/status/result/retry/export。
2. 增加 shared runtime schema 测试和根出口；consumer typecheck。
3. 创建 `packages/batch-lab` Vite React 包、AntD/React Query/app shell、统一 API client、环境 banner、导航和空路由；不实现用户登录/角色。
4. 参考 Admin/CS Platform新增包内 `vercel.json`、独立Vercel Project说明、SPA rewrite和Backend CORS example；不提交真实环境值，不新增Railway前端service或前端镜像。
5. 在现有CI quality gate显式增加Batch Lab test/build，确认根typecheck/lint/import guard覆盖新workspace。

**验证**：

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/batch-lab typecheck
pnpm --filter @miniapp/batch-lab test
pnpm --filter @miniapp/batch-lab build
pnpm -r typecheck
```

## 阶段 2：`batch_lab` 域与 repository

1. 按最终 ERD 新建 migration（禁止改历史）：schema、表、约束、索引、grants/RLS、RPC/租约函数、模板 seed（如采用）。
2. 更新 `DOMAIN_SCHEMAS`、PostgREST expose 操作文件、schema 地图、database module facts和安全文档。
3. 实现 Backend row mapper/repositories 与测试；UI/API不接触 row 类型。
4. test 单文件执行，记录执行前后 shape、权限/RLS、索引、锁等待、TOAST/容量估算、关键事务和独立回滚演练。

**回滚点**：尚未接入真实生成；migration 不通过则不部署后续 Backend。

## 阶段 3：样本 SQL、预览与冻结

1. 配置唯一来源环境标识和专用只读连接；默认 test。配置缺失即拒绝preview，不静默切换环境。
2. 实现模板参数编译、SELECT/WITH 单语句预检、只读事务、timeout/row/bytes limit。
3. 数据库层撤销来源凭据的全部写/DDL/危险函数权限并增加写语句负测；来源client只读，冻结写入使用独立平台client且只写`batch_lab`。
4. 实现锚点去重、历史/角色/动态输入补齐、排除原因、preview持久化和分页。
5. 实现preview digest/过期/修改失效与平台写库事务保存，保证保存不重新抽样且来源数据零写入。
6. 完成样本列表、创建、预览统计、全部样本/上下文和用于实验UI。

**失败测试**：SQL 语法、写语句、多语句、超时、零条、不足、重复锚点、历史缺失、预览过期、digest 不符、环境不符、并发双保存。

## 阶段 4：后处理不可变版本

1. 实现 `regex-json/v1` schema、规则/代码/input/output limits、编译校验、隔离执行硬超时和 sanitizer。
2. 实现 processor list/preview/create API 与不可变 repository。
3. 完成复制编辑、测试文本、预览、错误/零匹配、保存和用于实验 UI。
4. 核对/提取线上 renderer；保存 renderer version并标注差异。

**失败测试**：非法 JSON/flags/regex、灾难性回溯超时、超长输入输出、危险 HTML/CSS、零匹配、运行异常、旧版本不变。

## 阶段 5：实验配置、预检与真实生成接缝

1. 实现 A/B draft、整套深复制、模型/参数有效性、完整预设和 processor snapshot。
2. 实现真实结构化/文本 diff、目的、单轮/任意 X、有效样本排除、调用数确认。
3. 在 `features/generation` 提取/增加受控 `internal_research` policy，复用上游和模型解析，不预留用户额度、不查钱包、不写 chat_history。
4. 增加安全测试证明普通对话不能选择该 policy，Batch Lab不会修改 wallet/quota/chat_history。
5. 实现事务启动、frozen revision/idempotency和任务单元创建。

**回归**：现有 conversation/generation/quota/billing 全部相关测试和 MVP regression；用假上游验证请求体与 finish reason。

## 阶段 6：后台 worker、单轮/多轮与恢复

1. 实现数据库 lease/heartbeat/过期重领、全局与每实验有界并发、服务重启恢复。
2. 单轮和多轮按 sample+variant 串行；持久化每次 effective request、原文、finish reason、provider request id和 usage。
3. 实现失败→后序阻塞、有限自动重试、人工失败项重试和 unknown 状态。
4. 实现进度汇总：生成完成数与完整 A/B 样本数分开。
5. 完成结果页进度、逐样本/逐轮、分支历史、原文/富文本、完整组合、失败入口。

**故障注入**：第 2 轮失败/超时/截断/空输出、A/B 一边失败、429/5xx/4xx、Backend kill/restart、lease 双 worker、重复启动、处理失败。断言成功项不重复且 A/B 不串分支。

## 阶段 7：复用原文、历史、备注与 JSONL

1. 实现历史倒序列表、详情、复制完整配置。
2. 实现全批次全部轮次重新处理并保存 reuse experiment；断言 generation tasks=0，来源血缘完整。
3. 若排期包含备注/标签，实现按 experiment/sample/optional round upsert。
4. 实现 Backend 流式 JSONL，一样本一行，shared schema 验证，包含失败/blocked/unknown 和完整来源。
5. 用导出再导入 fixture 验证无需查询线上数据库即可还原输入、组合和结果。

## 阶段 8：全量验收与发布

1. 按 PRD S/C/G/P/D/R/E 全矩阵自动/人工验收；逐项保存证据。
2. 运行 shared/backend/batch-lab 及所有 shared 消费者 typecheck；Backend tests/MVP regression；Batch Lab test/build。
3. test 做默认 50 条单轮/3轮容量测试、并发/重启/导出测试；确认不影响真实聊天 API延迟。
4. 跑 Supabase security/performance advisors并处理或记录 remediation URL。
5. 更新 README、ARCHITECTURE、schema地图、Vercel/CI/环境example和相关module facts。
6. 按 migration → Backend feature-off → CI → Batch Lab Vercel Preview → feature-on/worker的顺序发布并演练回滚。

## Consumer 校验

- Shared：新增契约 browser-safe、兼容根出口，四个既有消费者 typecheck。
- Backend：普通会话/计费不回归；新route保留`@frontend-ready`、Pino allowlist和来源环境只读边界。V1不新增登录/角色鉴权。
- Batch Lab：所有服务端状态走统一 API/React Query；环境进入 query key；页面覆盖原型功能。
- CI/部署：独立Vercel静态SPA可构建和rewrite；Preview API base/CORS正确；不新增Railway前端service或镜像。
- Database：新域不被真实业务反向依赖；来源只读角色无法写来源业务schema或调用有副作用函数，平台client只写`batch_lab`。

## 发布恢复与停止

- 首选 feature flag 停止新 preview/start，worker 停领新任务但让当前 attempt 有界收口。
- 严重重复调用/环境串线/写入业务表时立即停 worker和入口，保留 attempt 证据，不自动清表。
- 回滚 SPA与 Backend时保留新增 schema可读；destructive DB rollback 延后单独审核。

## 子任务执行与归档顺序

1. 评审父任务及全部子任务规划，但只 `start` 下一项可执行子任务，不启动父任务代替子任务。
2. 依次完成并归档 `foundation`；随后可并行推进 `data-samples` 与 `postprocessing`。
3. 依赖稳定后推进 `backend-execution`，再推进 `frontend-workbench`，最后推进 `history-export`。
4. 每个子任务归档前提供：最终契约、变更路径、自动/人工验证、失败与恢复证据、未决风险、Spec/module update payload。
5. 六个实现子任务全部归档后，启动 `integration-spec`；任何缺口返回原 owner 子任务修复，不在收口任务中隐式扩面。
6. `integration-spec` 完成全量验收和 Spec/docs/module facts 后归档；最后再归档父任务。

## Spec 收口门禁

- 新增 `.trellis/spec/batch-lab/app/` 的入口、专题、Quality Check 和功能模块现状文件。
- 更新 Backend generation/runtime-data、Shared contracts/environment、Database storage/schema-security和Vercel/CI部署的真实实现事实。
- 更新 `.trellis/spec/modules-index.md` 必须通过生成脚本，不手工编辑。
- 更新 README 与 ARCHITECTURE 的包清单、依赖、路由、数据域、环境、部署、验证和已落地/待办状态。
- 所有文档必须区分已落地、待启用 production 和未知实况，不能把 test 结论写成 production事实。
