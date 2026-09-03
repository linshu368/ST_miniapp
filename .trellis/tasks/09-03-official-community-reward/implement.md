# 实施计划（待确认后执行）

## A. 决策与合同

- [ ] 关闭 PRD 全部待确认项，记录测试/生产配置负责人（仍缺 chat_id 与两环境启用时间）。
- [x] shared 先定义入口和验证 DTO、状态枚举。
- [x] 评审公开字段，不泄漏 Bot token、webhook secret 或数据库行。

## B. 数据库原子事实

- [x] 创建 claim、Telegram update receipt 与既有成员排除基线表。
- [x] 扩展 ledger `community_reward` 类型。
- [x] 实现 service-role-only 原子 RPC：事务内复核开关/配置/资格并原子写 claim、bonus wallet、ledger、official notification。
- [ ] 测试环境验证首次、重复、并发、失败回滚和四方对账。
- [x] migration 附上线检查和非破坏性回滚说明。

**门槛**：并发只产生 1 claim、1 ledger、1 通知和 +500 bonus；失败注入后均不落地。

## C. Telegram 与后端

- [x] 以独立 Community Bot webhook 接入 `chat_member`，不改已有 `/start` 和消息处理。
- [x] 实现 update_id 去重、目标群过滤、有效成员状态判断。
- [x] 实现 `getChatMember`、5 秒超时和错误归一化。
- [x] 新增 community feature、入口查询和主动验证路由。
- [x] 路由保留 `@frontend-ready`，业务配置统一走 runtime-config。
- [x] 补结构化错误日志和 webhook guard/client 单元测试。

**门槛**：伪造 user id、错误 secret、非目标群、非成员、未知用户均无法领奖。

## D. 前端体验

- [x] 新增 React Query hooks 和 Telegram URL 打开封装。
- [x] 实现 Sheet 的未验证、待验证、验证中、到账、已领取、不符合与异常状态。
- [x] 在消息中心与消费明细间插入入口，并补齐指定文案、图标和奖励提示。
- [x] 主动验证到账后失效 wallet、community 和 notification unread 缓存；未领取状态每 15 秒轮询以感知 webhook 到账。
- [ ] 补组件测试，人工检查移动安全区与桌面态（hook 测试已完成）。

**门槛**：打开群不触发发奖；服务端未返回 rewarded 前不显示到账。

## E. 联调与发布

- [ ] 测试群配置 Bot 管理员和 chat_member updates。
- [ ] UAT 覆盖新/老成员、待审批、漏 webhook、重复/并发、退群再入群、跳转失败。
- [ ] 对账 claim、wallet、ledger、notification 与前端余额/未读。
- [ ] 生产部署保持关闭，经年确认后启用并观测。

## 验证命令

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
```

数据库验证需另行记录测试环境执行、生产前 shape 检查与回滚说明；migration 不自动执行。

## 本地验证记录（2026-09-03）

- shared typecheck 通过；测试 62/62 通过。
- backend typecheck 通过；全量测试 390/390 通过；单一 Bot token 配置调整后 community 专项 13/13 通过。
- frontend typecheck 通过；全量测试 58/58 通过。
- 尚未执行测试数据库 migration、真实 Telegram UAT、并发/失败注入和四方账务对账。

## 回滚点

- 合同/代码异常：入口保持关闭并回滚应用版本。
- Telegram 事件异常：关闭总开关或停止 `chat_member` 处理。
- 发奖异常：立即关开关并按 claim/ledger 对账，不直接删 ledger 或手改 wallet。
- 已成功发放的奖励和通知默认保留，不通过代码回滚追回。
