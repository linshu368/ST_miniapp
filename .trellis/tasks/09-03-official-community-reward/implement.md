# 实施计划（待确认后执行）

## A. 决策与合同

- [ ] 关闭 PRD 全部待确认项，记录测试/生产配置负责人。
- [ ] shared 先定义入口和验证 DTO、状态枚举及运行时校验。
- [ ] 评审公开字段，不泄漏 Bot token、webhook secret 或数据库行。

## B. 数据库原子事实

- [ ] 创建 claim 和 Telegram update receipt。
- [ ] 扩展 ledger `community_reward` 类型。
- [ ] 实现 service-role-only 原子 RPC：claim、bonus wallet、ledger、official notification。
- [ ] 测试环境验证首次、重复、并发、失败回滚和四方对账。
- [ ] migration 附上线检查和非破坏性回滚说明。

**门槛**：并发只产生 1 claim、1 ledger、1 通知和 +500 bonus；失败注入后均不落地。

## C. Telegram 与后端

- [ ] 增量扩展 update 类型，不破坏已有 `/start` 和消息处理。
- [ ] 实现 update_id 去重、目标群过滤、有效成员状态判断。
- [ ] 实现 `getChatMember` 和超时/限流处理。
- [ ] 新增 community feature、入口查询和主动验证路由。
- [ ] 路由保留 `@frontend-ready`，配置统一走 runtime-config。
- [ ] 补结构化日志和测试。

**门槛**：伪造 user id、错误 secret、非目标群、非成员、未知用户均无法领奖。

## D. 前端体验

- [ ] 新增 React Query hooks 和 Telegram URL 打开封装。
- [ ] 实现 Sheet 的加载、未验证、待验证、验证中、到账、已领取和异常状态。
- [ ] 在消息中心与消费明细间插入入口。
- [ ] 到账后失效 wallet、community 和 notification unread 缓存。
- [ ] 补组件/hook 测试，检查移动安全区与桌面态。

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

## 回滚点

- 合同/代码异常：入口保持关闭并回滚应用版本。
- Telegram 事件异常：关闭总开关或停止 `chat_member` 处理。
- 发奖异常：立即关开关并按 claim/ledger 对账，不直接删 ledger 或手改 wallet。
- 已成功发放的奖励和通知默认保留，不通过代码回滚追回。
