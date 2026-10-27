# 实施计划

状态：本地实现与自动验证已完成；真实 Supabase API smoke、部署及发布后 Sentry 对照未执行。

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

### Production 基线与判定口径

- 上线前基线固定为 release `88cd811b46c2e9421875a1e9182c5efc6b7ab0eb`、2026-10-27 15:00–16:36（Asia/Shanghai）；新版本必须按独立 release 过滤，排除部署后前 5 分钟冷启动。
- 同时保留 2026-10-26 15:00–16:36 同时段作为自然波动参照。该窗口发生 Supabase 故障，不能直接拿它证明本次代码收益。
- 页面 p95 仅在单路由接收样本 `n >= 100` 或覆盖一个完整业务高峰后做最终结论；低样本只做预警。
- 主要验收不是单看 Supabase 单次 p95，而是 `users`、`runtime_config` span 数 / authenticated `http.server` 数的比率下降，且目标接口 p95、5xx 不回归。
- 推荐停止/回滚线：暖机后且 `n >= 100` 的目标页面或接口 p95 比同流量基线恶化 20%；鉴权相关 5xx 超过 1%；`/api/payment/plans` 出现 3 次连续 smoke 失败或 503 超过 1%；Supabase `internal_error`、5s/30s timeout 重新出现并与新 release 强相关。

### 已识别风险

- 用户身份缓存按 Backend 进程隔离，多副本不会共享；这只会降低命中率，不改变数据权威性。60 秒内若用户行被删除并以新 ID 重建，旧身份可能短暂命中；鉴权仍逐请求执行，失败不会进入缓存。
- single-flight 会让同一时刻的等待者共享首个上游结果；一次瞬时失败可能形成相关失败，但失败不缓存，下一请求会重新读取。
- runtime-config 的首个默认 5 秒超时会约束同键等待者；strict 和自定义 signal 不参与共享，避免取消语义串扰。
- payment plans 批量读取由多次独立读取变为一次快照；网络失败时关键套餐继续 fail-closed 返回 503，可能形成相关失败，但不会用默认套餐创建错误订单。
- Sentry span 在基线窗口仅约 3% 被接收，约 97% 因 `no_parent_span` 被客户端丢弃。p95 和 count 只能代表已接收样本，必须同时看 release、样本量、错误率和 dropped outcomes。
