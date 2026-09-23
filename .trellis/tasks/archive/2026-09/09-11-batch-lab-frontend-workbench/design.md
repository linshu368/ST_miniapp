# 技术设计：Batch Lab 前端工作台功能

## 1. 边界与数据流

本任务负责：

- 应用壳、实验记录、样本集、富文本后处理导航和新建实验
- SQL模板/参数/编辑/preview/冻结页面与全样本上下文
- A/B 完整组合、整套复制、单轮/任意 X、目的、确认规模与差异
- 运行进度、逐样本逐轮、分支上下文、原文/富文本、完整组合和失败入口
- processor 复制编辑/预览/保存/用于实验页面
- loading/error/empty/partial/stale/unauthorized/env-mismatch、可访问性与窄屏

不负责：

- Backend route/service/repository/worker
- migration
- 客户端自造 SQL/生成/processor 业务真相
- history/reuse/export 后端语义

所有对外形状先进入 shared；UI → 统一 client/hook → Backend route → feature/service → repository → Supabase。不得跨应用 import 或建立平行生成、运行时配置、日志、迁移来源。

## 2. 复用设计

- 复用父任务 `research/current-state.md` 的结论：Admin 身份/环境模式、CS React Query 模式、Shared Zod/envelope、Backend engine/generation/runtime config、Supabase domain repository。
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

至少覆盖：无权限/会话过期、环境指纹错配、配置缺失、请求取消/超时、重复 mutation、并发竞态、数据库不可用、部分成功、服务重启、未知外部结果、大响应/容量超限。各业务特有失败按 PRD验收逐项测试。

## 6. 最小方案与拒绝项

只增加完成本任务所需文件、状态和接口。不引入微服务、通用工作流、复杂 RBAC、外部队列或多数据源框架。若单 Backend worker容量不足，优先用同一 Backend 包独立 worker进程，不复制业务服务。

## 7. 演进与恢复

先 test 契约/迁移/Backend，再发布 SPA或开启入口；每步 smoke 后继续。停止条件包括越权、串环境、可写源 SQL、真实会话/钱包污染、重复调用、分支串线、日志泄露和容量异常。回滚优先 feature flag/停领任务/回退应用；数据库保留可读并 forward-fix，破坏性回滚单独审核。

## 8. Spec 责任

建立 Batch Lab app 页面/组件/API数据流/测试部署规范和 workbench/client-auth module facts。
