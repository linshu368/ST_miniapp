# Batch Lab 后处理与富文本渲染

## 1. 目标

实现不可变后处理版本、安全隔离 regex-json 执行器、展示清洗、renderer 版本与 display result。 本任务是父任务的“后处理与渲染安全”交付单元，必须独立实现、验证和归档。

## 2. 前置依赖

- 09-11-batch-lab-foundation
- 09-11-batch-lab-data-samples 的 processor/display 存储

依赖不是目录层级的隐含顺序；依赖任务的契约、迁移或证据未完成时，本任务保持 Blocked，不用临时 mock 冒充集成完成。

## 3. 必须交付

- none/v1 与 regex-json/v1 不可变 processor version/digest
- 规则语法/flags/数量/输入输出限制和有序替换
- 可硬终止 worker/subprocess、执行超时、并发/内存限制与 ReDoS 防护
- syntax/validation/runtime/timeout/limit/zero-match 错误语义
- allowlist sanitizer、renderer protocol/version 和手机消息宽度预览
- preview 与持久 display result 共用权威 executor

## 4. 明确不做

- 模型生成
- 实验通用状态机
- reuse 实验创建与 JSONL
- 任意 JavaScript 执行器

不得借本任务增加父 PRD 和 HTML 原型没有的功能。若实现发现父需求冲突，返回父规划评审，不静默扩面。

## 5. 通用约束

- 应用包之间只通过 HTTP/shared contract 协作；浏览器不使用数据库 row、service-role或密钥。
- 所有外部调用有明确超时；重试有限且仅用于安全操作；关键写入以数据库约束/事务/幂等键裁决。
- test 与 production 分开记录环境、指纹和证据；生产变更不随应用发布自动执行。
- 原始错误以 `{ err }` 记录；日志只含 allowlist 摘要、内部 ID、环境、状态和耗时，不记录 SQL敏感值、完整 prompt/回复或 token。

## 6. 验收标准

- [ ] 编辑仅复制并新建版本，旧版本/旧 display result 不变
- [ ] 零匹配为 success+0，所有失败保留原文且不返回空白
- [ ] 灾难性回溯被硬终止且不阻塞 Fastify event loop或遗留 worker
- [ ] 危险标签/属性/URL/CSS被清洗，原文/代码按文本展示
- [ ] 批处理与单条预览执行语义一致，后处理产物不进入生成上下文
- [ ] 失败、空、部分成功、未授权、超时、重复提交与环境错配路径均有自动测试或可重复人工证据。
- [ ] 受影响消费者、文档和 module facts 已按本任务责任更新或向最终收口任务提供审核 payload。
