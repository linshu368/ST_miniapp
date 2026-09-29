# Batch Lab Backend 实验与生成执行

## 1. 目标

实现 A/B 冻结配置、内部研发生成策略、持久租约 worker、单轮/多轮分支及失败恢复。 本任务是父任务的“Backend 实验与生成状态机”交付单元，必须独立实现、验证和归档。

## 2. 前置依赖

- 09-11-batch-lab-foundation
- 09-11-batch-lab-data-samples
- 09-11-batch-lab-postprocessing 的稳定 processor/display 接口

依赖不是目录层级的隐含顺序；依赖任务的契约、迁移或证据未完成时，本任务保持 Blocked，不用临时 mock 冒充集成完成。

## 3. 必须交付

- A/B 模型/参数/完整预设/processor snapshot、深复制与真实 diff
- 启动预检、排除、调用数、frozen revision 和幂等启动
- features/generation 内受控 internal_research policy
- 数据库任务租约、heartbeat、SKIP LOCKED 等价领取和重启恢复
- 单轮与最后 X 轮分支串行、跨样本有界并发
- attempt/effective request/raw output/finish reason/usage、失败阻塞、有限重试和 unknown

## 4. 明确不做

- 源 SQL 与样本冻结
- processor 执行器实现
- 页面实现
- reuse/JSONL

不得借本任务增加父 PRD 和 HTML 原型没有的功能。若实现发现父需求冲突，返回父规划评审，不静默扩面。

## 5. 通用约束

- 应用包之间只通过 HTTP/shared contract 协作；浏览器不使用数据库 row、service-role或密钥。
- 所有外部调用有明确超时；重试有限且仅用于安全操作；关键写入以数据库约束/事务/幂等键裁决。
- test 与 production 分开记录环境、指纹和证据；生产变更不随应用发布自动执行。
- 原始错误以 `{ err }` 记录；日志只含 allowlist 摘要、内部 ID、环境、状态和耗时，不记录 SQL敏感值、完整 prompt/回复或 token。

## 6. 验收标准

- [ ] Batch Lab 不预留免费额度、不查/扣钱包、不写 experience.chat_history
- [ ] 普通会话无法选择 internal_research 策略
- [ ] 多轮用户输入不变，A/B 只接自己的前序原文，display HTML 不进上下文
- [ ] 第 k 轮失败使后续阻塞，重试不重跑前序或其他成功项
- [ ] 重复启动、双 worker、Backend kill/restart 不重复成功调用
- [ ] 失败、空、部分成功、未授权、超时、重复提交与环境错配路径均有自动测试或可重复人工证据。
- [ ] 受影响消费者、文档和 module facts 已按本任务责任更新或向最终收口任务提供审核 payload。
