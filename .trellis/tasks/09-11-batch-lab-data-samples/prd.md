# Batch Lab 数据库域、环境与样本集

## 1. 目标

建立 batch_lab 数据域、专用只读来源连接、SQL 模板/预览、锚点补齐和不可变样本冻结。 本任务是父任务的“数据库、环境和样本集链路”交付单元，必须独立实现、验证和归档。

## 2. 前置依赖

- 09-11-batch-lab-foundation

依赖不是目录层级的隐含顺序；依赖任务的契约、迁移或证据未完成时，本任务保持 Blocked，不用临时 mock 冒充集成完成。

## 3. 必须交付

- batch_lab schema、样本相关表、约束/索引/grants/RLS/RPC与 repository
- 唯一来源环境标识和专用只读连接；配置缺失时拒绝preview
- 工程 SQL 模板、参数绑定、单 SELECT/WITH 预检与 READ ONLY 事务
- 来源连接对环境业务schema仅有必要SELECT且无写/DDL/危险函数权限；平台写入使用独立client并只进入`batch_lab`
- statement/lock timeout、行数/字节/并发限制
- 锚点去重、真实 turn/角色/动态输入补齐、排除原因
- preview digest/TTL/一次性事务冻结和不可变样本集

## 4. 明确不做

- A/B 实验配置
- LLM 调用与 worker
- 后处理
- 结果与 JSONL
- 生产样本合规、脱敏和审批流程

不得借本任务增加父 PRD 和 HTML 原型没有的功能。若实现发现父需求冲突，返回父规划评审，不静默扩面。

## 5. 通用约束

- 应用包之间只通过 HTTP/shared contract 协作；浏览器不使用数据库 row、service-role或密钥。
- 所有外部调用有明确超时；重试有限且仅用于安全操作；关键写入以数据库约束/事务/幂等键裁决。
- test与production来源配置分开记录；V1不建设生产合规、脱敏或审批流程。
- 原始错误以 `{ err }` 记录；日志只含 allowlist 摘要、内部 ID、环境、状态和耗时，不记录 SQL敏感值、完整 prompt/回复或 token。

## 6. 验收标准

- [ ] 写 SQL、多语句、危险 schema/函数被拒绝且只读角色物理上无写权限
- [ ] 参数/SQL/limit/source 改动使旧 preview 失效
- [ ] 保存使用同一 preview，不重新抽样；零有效样本不可保存
- [ ] 重复、不足、历史缺失分别统计，冻结内容不随源库变化
- [ ] 来源只读凭据缺失即拒绝preview，不静默切换环境
- [ ] 来源角色无法INSERT/UPDATE/DELETE/TRUNCATE/DDL或调用有副作用函数；冻结写入只使用平台client写`batch_lab`
- [ ] 失败、空、部分成功、超时、重复提交与环境错配路径均有自动测试或可重复人工证据。
- [ ] 受影响消费者、文档和 module facts 已按本任务责任更新或向最终收口任务提供审核 payload。
