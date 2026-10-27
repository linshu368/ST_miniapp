# 实施计划

状态：规划待审核；在任务 `start` 前不修改产品代码。

## 步骤 1：身份解析 single-flight 与有界缓存

- 在 `packages/backend/src/lib/user.ts` 定义只含 `id`、`created_at` 的身份类型。
- 为 `getOrCreateDbUser` 增加按 Telegram ID 的 TTL cache、容量上限和 in-flight Map。
- 成功后才缓存；失败在 `finally` 清理；不改现有完整 get-or-create、首次创建与 race reread。
- 将 invite、telemetry 等需要可变字段的调用点改为完整读取函数，并让类型检查阻止遗漏。
- 新增就近单测锁定并发、失败、过期、容量和用户隔离。并发缓存属于共享鉴权热路径，风险评估要求创建回归测试。

## 步骤 2：runtime-config 在途请求合并

- 重构 `runtime-config.ts` 的实际读取为私有函数。
- 非严格单键和批量读取在无自定义 signal 时使用 stable key single-flight。
- 严格读取和自定义 signal 保持直读；批量返回独立 Map。
- 新增就近单测锁定相同/不同 key、signal 隔离、失败后恢复。

## 步骤 3：Payment plans 同表批量读取

- 在 `rechargeRules.ts` 增加一次读取四个页面配置 key 的 snapshot 函数，复用现有 parser/default。
- `/api/payment/plans` 改为调用 snapshot + `readVipStrategy`，公开响应不变。
- 扩展现有 recharge rules / payment route 测试，覆盖有效、套餐缺失/损坏和非关键字段 fallback。
- 订单创建继续走权威套餐读取，不复用页面 snapshot。

## 步骤 4：验证

```powershell
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/backend lint
git diff --check
```

若 Backend 没有 `lint` script，记录为不适用并运行仓库已有静态检查，不新增替代脚本。

人工注入/本地场景：

1. 并发触发 profile 多个 authenticated GET，确认同用户 `users` 回源收敛且响应身份一致。
2. 首次用户创建、Supabase 读取失败后恢复、不同 Telegram 用户并发。
3. `/api/payment/plans` 有效配置、套餐缺失/损坏返回 503、文案/页面配置缺失回默认。
4. `/profile`、`/profile/spending`、发现页进入聊天、签到和 latest badge smoke。

## 步骤 5：发布后 Sentry 对照（不在本地实现授权内）

- 同 environment/release/流量窗口对比 `/profile`、`/profile/spending`、`/chat/:characterId` navigation p95。
- 对比目标 `http.server` p95/5xx；聊天 messages/regenerate 分开看准备阶段与供应商阶段。
- 对比 Supabase `users`、`runtime_config` count / authenticated server request count，以及 internal_error、>5s 与 dropped outcomes。
- 记录部署 SHA、窗口和采样缺口；至少观察一个完整业务高峰再判定达标。
