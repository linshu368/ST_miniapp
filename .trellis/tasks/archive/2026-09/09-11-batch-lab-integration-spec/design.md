# 技术设计：Batch Lab 集成验收、发布与 Spec 收口

## 1. 边界与数据流

本任务负责：

- 父 PRD S/C/G/P/D/R/E→子任务→证据→owner 全量矩阵
- test SQL→冻结→A/B单/多轮→失败恢复→结果→reuse→JSONL E2E
- 50条单轮/3轮容量、TOAST、SQL/worker/export硬限额与线上延迟
- kill/restart/双worker/过期lease/重复start/retry/unknown故障演练
- migration→Backend feature-off→CI→Vercel SPA→worker/feature-on发布和回滚/停止演练
- Vercel Preview API base、SPA rewrite、Backend CORS和来源只读写入负测
- 新增 Batch Lab spec、module facts并更新既有规范、README、ARCHITECTURE

不负责：

- 新增或偷补产品功能
- 生产样本合规、脱敏、审批或自动启用流程
- 破坏性清库
- 用文档掩盖未通过验收

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

至少覆盖：环境错配、配置缺失、请求取消/超时、重复mutation、并发竞态、数据库不可用、部分成功、服务重启、未知外部结果、大响应/容量超限和来源写入负测。各业务特有失败按PRD验收逐项测试。

## 6. 最小方案与拒绝项

只增加完成本任务所需文件、状态和接口。不引入微服务、通用工作流、复杂 RBAC、外部队列或多数据源框架。若单 Backend worker容量不足，优先用同一 Backend 包独立 worker进程，不复制业务服务。

## 7. 演进与恢复

先 test 契约/迁移/Backend，再发布 SPA或开启入口；每步 smoke 后继续。停止条件包括越权、串环境、可写源 SQL、真实会话/钱包污染、重复调用、分支串线、日志泄露和容量异常。回滚优先 feature flag/停领任务/回退应用；数据库保留可读并 forward-fix，破坏性回滚单独审核。

## 8. Spec 责任

本任务是最终Spec owner：新增`.trellis/spec/batch-lab/app/`入口、专题、modules/index和至少workbench/client-environment-deployment模块；更新Backend/Shared/Database facts与总索引。
