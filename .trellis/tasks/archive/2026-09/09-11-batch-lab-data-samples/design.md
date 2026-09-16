# 技术设计：Batch Lab 数据库域、环境与样本集

## 1. 边界与数据流

本任务负责：

- batch_lab schema、样本相关表、约束/索引/grants/RLS/RPC与 repository
- 唯一来源环境标识和专用只读连接；配置缺失时拒绝preview
- 工程 SQL 模板、参数绑定、单 SELECT/WITH 预检与 READ ONLY 事务
- 来源角色对环境业务schema仅有必要SELECT，无写/DDL/危险函数权限；平台写入使用独立client且只进入`batch_lab`
- statement/lock timeout、行数/字节/并发限制
- 锚点去重、真实 turn/角色/动态输入补齐、排除原因
- preview digest/TTL/一次性事务冻结和不可变样本集

不负责：

- A/B 实验配置
- LLM 调用与 worker
- 后处理
- 结果与 JSONL

所有对外形状先进入 shared；UI → 统一 client/hook → Backend route → feature/service → repository → Supabase。不得跨应用 import 或建立平行生成、运行时配置、日志、迁移来源。

## 2. 复用设计

- 复用父任务`research/current-state.md`的结论：Admin/CS Vercel部署模式、CS React Query模式、Shared Zod/envelope、Backend engine/generation/runtime config、Supabase domain repository。
- 复用是提取稳定纯能力或沿用协议，不从另一个应用包直接 import 源码。
- 旧 ST/simulation、真实 chat_history 写入、用户钱包计费、原型内存状态和任意 JS执行均不复用。

## 3. 状态与一致性

- 服务器/数据库是真相源；UI禁用只改善体验，不承担并发正确性。
- 冻结对象以稳定 ID、版本、digest和 source environment追溯；成功事实不覆盖。
- 跨数据库、LLM或worker边界无法使用单事务时，以 attempt/lease 状态和补偿/恢复收口。
- 列表使用摘要与分页，大文本详情按需读取；缓存 key 必须包含环境和资源身份。

## 4. 可靠性与安全

| 项     | 设计要求                                                        |
| ------ | --------------------------------------------------------------- |
| 超时   | DB、HTTP、LLM、worker/处理和导出均设置显式预算                  |
| 重试   | 仅安全瞬时失败，有限退避；4xx/校验错误不自动重试                |
| 幂等   | mutation 使用资源版本/Idempotency-Key，数据库唯一键最终裁决     |
| 并发   | 有界并发、租约/锁/唯一约束；不得依赖单实例假设                  |
| 事务   | 冻结/建任务/状态转换原子；外部副作用记录 attempt和不确定态      |
| 降级   | 单项失败不拖垮独立项；历史只读在来源不可用时仍可访问            |
| 容量   | 输入、SQL、行、字节、轮数、输出、并发和导出均有限额             |
| 可观测 | 内部 ID、环境、阶段、状态、耗时、request id；正文与密钥禁入日志 |

## 5. 失败模型

至少覆盖：环境错配、只读配置缺失、写入负测、请求取消/超时、重复mutation、并发竞态、数据库不可用、部分成功、服务重启和大响应/容量超限。各业务特有失败按PRD验收逐项测试。

## 6. 最小方案与拒绝项

只增加完成本任务所需文件、状态和接口。不引入微服务、通用工作流、复杂 RBAC、外部队列或多数据源框架。若单 Backend worker容量不足，优先用同一 Backend 包独立 worker进程，不复制业务服务。

## 7. 演进与恢复

先 test 契约/迁移/Backend，再发布 SPA或开启入口；每步 smoke 后继续。停止条件包括越权、串环境、可写源 SQL、真实会话/钱包污染、重复调用、分支串线、日志泄露和容量异常。回滚优先 feature flag/停领任务/回退应用；数据库保留可读并 forward-fix，破坏性回滚单独审核。

## 8. Spec 责任

新增 database Batch Lab storage module fact；更新 schema-security、conversation-storage、Backend data access、Shared environment 与 schema 归属地图。
