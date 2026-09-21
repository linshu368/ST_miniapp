# Batch Lab 前端工作台功能

## 1. 目标

按 HTML 原型实现 Batch Lab 全页面、向导、进度和逐样本逐轮对比，并接入 shared API。 本任务是父任务的“Batch Lab SPA 产品界面”交付单元，必须独立实现、验证和归档。

## 2. 前置依赖

- 09-11-batch-lab-foundation
- 09-11-batch-lab-data-samples
- 09-11-batch-lab-postprocessing
- 09-11-batch-lab-backend-execution

依赖不是目录层级的隐含顺序；依赖任务的契约、迁移或证据未完成时，本任务保持 Blocked，不用临时 mock 冒充集成完成。

## 3. 必须交付

- 应用壳、实验记录、样本集、富文本后处理导航和新建实验
- SQL模板/参数/编辑/preview/冻结页面与全样本上下文
- A/B 完整组合、整套复制、单轮/任意 X、目的、确认规模与差异
- 运行进度、逐样本逐轮、分支上下文、原文/富文本、完整组合和失败入口
- processor 复制编辑/预览/保存/用于实验页面
- loading/error/empty/partial/stale/unauthorized/env-mismatch、可访问性与窄屏

## 4. 明确不做

- Backend route/service/repository/worker
- migration
- 客户端自造 SQL/生成/processor 业务真相
- history/reuse/export 后端语义

不得借本任务增加父 PRD 和 HTML 原型没有的功能。若实现发现父需求冲突，返回父规划评审，不静默扩面。

## 5. 通用约束

- 应用包之间只通过 HTTP/shared contract 协作；浏览器不使用数据库 row、service-role或密钥。
- 所有外部调用有明确超时；重试有限且仅用于安全操作；关键写入以数据库约束/事务/幂等键裁决。
- test 与 production 分开记录环境、指纹和证据；生产变更不随应用发布自动执行。
- 原始错误以 `{ err }` 记录；日志只含 allowlist 摘要、内部 ID、环境、状态和耗时，不记录 SQL敏感值、完整 prompt/回复或 token。

## 6. 验收标准

- [ ] 原型页面/控件→PRD→组件/route→验收证据矩阵无遗漏
- [ ] 组件不直接 fetch，React Query key 包含 backend/source environment
- [ ] 表单改变使旧 preview UI立即失效；mutation 防重复并展示明确结果
- [ ] 结果可定位任意样本/轮次/分支失败，原文与富文本来源不混淆
- [ ] 键盘、焦点、表格横向滚动、窄屏和高风险 production banner 可用
- [ ] 失败、空、部分成功、未授权、超时、重复提交与环境错配路径均有自动测试或可重复人工证据。
- [ ] 受影响消费者、文档和 module facts 已按本任务责任更新或向最终收口任务提供审核 payload。
