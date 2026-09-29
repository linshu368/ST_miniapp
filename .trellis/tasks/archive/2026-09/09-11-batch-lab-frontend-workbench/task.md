# Task Breakdown

## 依赖

- 09-11-batch-lab-foundation
- 09-11-batch-lab-data-samples
- 09-11-batch-lab-postprocessing
- 09-11-batch-lab-backend-execution

## Tasks

| ID  | Status | Task                                   | Files / Scope               | Depends On | Verification                                          |
| --- | ------ | -------------------------------------- | --------------------------- | ---------- | ----------------------------------------------------- |
| T0  | Done   | 人工评审并确认依赖/环境/安全门禁       | task artifacts + target env | -          | 用户继续执行授权；依赖任务已归档                      |
| T1  | Done   | 核对 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | 复用既有 batch-lab shared 契约与 client tests         |
| T2  | Done   | 核对持久边界、事务/幂等与 repository   | backend/database            | T1         | 仅接入 frontend-ready API，不新增后端/DB              |
| T3  | Done   | 实现 Batch Lab SPA 产品界面核心能力    | owned application files     | T2         | App/workbench helper/tests/build                      |
| T4  | Done   | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | 错误态、空态、环境 banner、preview 失效、重复提交禁用 |
| T5  | Done   | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | 本任务提供 integration-spec 收口 payload              |

## 完成定义

- [x] 原型页面/控件→PRD→组件/route→验收证据矩阵无遗漏；history/export 后端读端未开放项以真实空态交接。
- [x] 组件不直接 fetch，React Query key 包含 backend/source environment。
- [x] 表单改变使旧 preview UI 立即失效；mutation 防重复并展示明确结果。
- [x] 结果页可查看实验摘要、进度、冻结 A/B 差异；逐样本逐轮结果读端留给 history-export，不使用 mock 冒充完成。
- [x] 键盘、焦点、表格横向滚动、窄屏和高风险 production banner 可用。
- [x] 验证命令、失败路径、发布/回滚和 Spec/module payload 完整。
- [x] 本任务独立归档后，父任务仍不完成；必须等待 integration-spec 全量收口。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0等待人工评审。
- 2026-09-16：用户授权继续执行；依赖 `foundation`、`data-samples`、`postprocessing`、`backend-execution` 已完成并归档。
- 2026-09-16：实现 `packages/batch-lab` 工作台页面：
  - 主导航：实验记录、样本集、富文本后处理、新建实验。
  - 样本集：SQL 模板、参数 JSON、SQL 编辑、preview 统计、上下文浏览、冻结保存。
  - 后处理：复制编辑、规则 JSON 校验、Backend preview、保存不可变 processor version、富文本预览。
  - 新建实验：选择样本集、A/B 模型/采样/processor、从 A 复制、确认页展示计划调用数与差异、创建草稿并可启动。
  - 实验记录：状态进度、启动、worker run-once、A/B 差异抽屉；逐样本逐轮结果因当前稳定 API 未提供详情读端，保留明确真实空态交给 history-export。
- 2026-09-16：新增 `src/lib/workbench.ts` 与测试，覆盖 JSON 参数、采样、正则规则、processor config 和实验进度。
- 2026-09-16：验证通过：
  - `pnpm --filter @miniapp/batch-lab typecheck`
  - `pnpm --filter @miniapp/batch-lab test`
  - `pnpm --filter @miniapp/batch-lab build`（通过；保留既有 Vite >500k chunk warning）
