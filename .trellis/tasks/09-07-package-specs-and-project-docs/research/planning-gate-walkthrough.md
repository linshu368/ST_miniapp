# Trellis 规划门禁样例走查

## 样例：新增“CS 客服补发社区奖励”跨包能力

该样例仅验证规范可执行性，不代表真实需求或待开发功能。

### PRD 应回答

- 运营者、目标用户、允许补发原因、权限与验收；重复操作的业务结果。
- 范围涉及 CS UI、shared DTO、backend route、billing/community 数据，不允许 CS 直连数据库。
- 关键质量属性：同一补发请求不重复记账；失败可诊断/恢复；不要求无依据的全局 SLO。

### Design 应回答

- 复用：现有 CS `api.ts`/React Query、shared community/wallet envelope、backend generation/wallet repository 或数据库原子函数；逐项说明扩展理由。
- 故障：前端重复点击、请求超时但服务端已成功、并发补发、余额写成功但审计失败、权限错误。
- 最小方案：新增一个 shared 请求/响应契约、一个 CS helper/mutation、一个 backend route/feature；原子记账放现有钱包边界，不建立新队列或通用工作流框架。
- 可靠性：idempotency key、数据库原子操作、有限只读重试、写入不盲重试、Pino allowlist 审计、成功后刷新权威余额。
- 兼容/回滚：先 additive contract/backend，再 UI；关闭入口可回滚 UI，已入账记录不做破坏性回滚，使用补偿流水。

### Implement/Task 应拆分

1. shared additive DTO + contract tests；
2. backend 权限/幂等/原子写 + 成功/重复/并发/失败测试；
3. CS mutation、确认、禁重、错误与缓存刷新；
4. typecheck/tests/build、日志脱敏人工检查和测试环境 smoke test；
5. 发布顺序和停止条件。

## 结论

新增 AGENTS 和四类 spec 能将高可用、复用和简洁转为可执行问题：可靠性来自重复记账这一真实故障；复用来自现有钱包/契约/API client；简洁来自最小新增面并拒绝无依据队列。规则同时覆盖失败路径、兼容和回滚，不只覆盖 happy path。
