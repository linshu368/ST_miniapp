# 技术设计：Sentry 高延迟公共链路收敛

## 1. 结论

首批只做两类后端请求收敛：

1. `getOrCreateDbUser` 返回并缓存不可变身份 `{ id, created_at }`，用 bounded TTL cache + single-flight 合并页面扇出的同用户查询；确需 `source_id` / `total_round` 的少数调用方继续使用完整用户读取。
2. `runtime-config.ts` 对无调用方 signal 的非严格单键/同键集读取增加 in-flight 合并；`/api/payment/plans` 把四条页面配置读取合并为一次批量查询。

这两处分别对应报告中最高频的 Supabase `users` 和 `runtime_config`。不改 Frontend 契约，页面通过共享 API 热路径获得收益。

## 2. 复用调研

| 已检索能力                                          | 结论                                                                                                                    | 决策                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `lib/user.ts`、约 55 个 route 调用点                | 绝大多数只使用 `id`，wallet check-in 额外使用不可变 `created_at`；invite 使用 `source_id`，telemetry 使用 `total_round` | 扩展现有 helper；身份缓存类型只暴露不可变字段，invite/telemetry 显式走完整读取 |
| `platform/runtime-config.ts`                        | 已是统一入口，批量读取已有 5s 上限；缺少并发合并                                                                        | 在原入口增加 single-flight，不新建 client/helper 层                            |
| payment `rechargeRules.ts`                          | `/api/payment/plans` 目前同表四次读取并与 VIP 策略并发                                                                  | 新增同 domain 的页面配置批量解析函数，复用现有 schema/default                  |
| `features/lobby/ranking-stats.ts`                   | 已有 60s TTL 与 single-flight                                                                                           | 不改，避免重复方案                                                             |
| Frontend React Query / request concurrency          | 已有 Query 去重、3 槽优先级与页面分阶段加载                                                                             | 不新增 bootstrap API，不改 UX/freshness                                        |
| 既有性能任务 `10-21-production-request-performance` | 已完成 30s 全局兜底、users/批量 config 5s 上限、会话上下文合并                                                          | 本任务不重复 timeout 改动，补请求量收敛                                        |

## 3. 用户身份缓存

### 3.1 数据形状

`getOrCreateDbUser` 的返回类型收窄为 `MiniappDbUserIdentity = Pick<MiniappDbUser, 'id' | 'created_at'>`。缓存键为 Telegram `id` 字符串，值只包含这两个不可变字段与过期时刻。

完整的 `getOrCreateMiniappUserByTgId` 行为不变，继续服务 bot、growth、invite 和 telemetry 等需要可变字段的调用方。这样由类型系统阻止未来从身份缓存读取 `source_id`、`total_round` 等陈旧字段。

### 3.2 算法

- fresh cache hit：直接返回身份。
- miss 且已有同 key in-flight：复用 Promise。
- miss：调用现有完整 get-or-create；成功投影并写缓存；`finally` 清除 in-flight。
- reject：不写缓存，下一请求可重试。
- 缓存采用短 TTL、固定最大条目数与惰性过期清理；达到上限时按 Map 插入顺序淘汰最旧项。具体常量在实现时集中定义并由测试锁定。

Telegram initData 仍在每个请求的 `requireTelegramAuth` 中验证。缓存不代替鉴权，也不缓存钱包/权益/额度。多副本各自缓存不影响正确性；首次创建仍由数据库 `tg_id` 唯一约束和既有 race reread 保证幂等。

## 4. Runtime config single-flight

- `fetchRuntimeConfigEntryStrict`：不变；严格调用每次直读。
- `fetchRuntimeConfigEntry(key, signal)`：仅 `signal` 未提供时按 key 合并当前 in-flight；有 signal 时独立执行，避免一个调用方取消其他请求。
- `fetchRuntimeConfigEntries(keys, signal)`：keys 去重、排序后形成稳定签名；仅未提供 signal 时合并完全相同键集。内部仍创建现有 5s 默认 signal。
- Promise 在 `finally` 删除；错误/空结果不跨请求缓存。批量 Map 返回副本，避免调用方修改共享结果。

该设计没有 TTL，因此运营配置传播语义不变。不同键集不做复杂的交集拆分；当前真实高频调用（profile 的多个 `readVipStrategy`、生成链路的固定 key sets）已能获益，避免建立通用缓存框架。

## 5. Payment plans 批量读取

在 `rechargeRules.ts` 增加 payment page runtime snapshot 读取：一次 `fetchRuntimeConfigEntries` 读取套餐、充值页、支付提示与余额不足文案四个 key，然后复用现有 Zod parser/default。

- 套餐缺失/损坏：继续抛 `PaymentPlansConfigError`，route 返回 503。
- 页面/提示/文案缺失：保持现有默认值。
- VIP 策略仍走 `readVipStrategy`，但同一 profile 请求波次可通过 runtime-config single-flight 与其他 VIP/check-in 请求共享读取。
- 创建订单仍重新按现有 `findPaymentPlan` 读取权威套餐，不依赖页面快照，避免改变金额校验与计费语义。

## 6. 可靠性设计

| 故障模型                | 处理                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Supabase 慢/断网        | 复用现有 5s/30s deadline；single-flight 降低同一故障的并发放大，不增加重试          |
| Promise 失败            | `finally` 清 in-flight，失败不缓存；后续请求可恢复                                  |
| 首次用户并发创建        | 继续依赖 `tg_id` unique + race reread，不用进程锁替代数据库一致性                   |
| 多副本                  | 每副本独立去重；正确性不依赖共享缓存，只影响命中率                                  |
| cache 容量              | 固定上限 + 惰性清理/最旧淘汰；不随用户数无界增长                                    |
| stale identity          | 只缓存不可变 `id`/`created_at`；可变字段不进入公开返回类型                          |
| caller abort            | 自定义 signal 不参与 runtime-config single-flight，取消隔离                         |
| payment config 部分缺失 | 套餐 fail closed；非关键展示字段沿现有安全默认                                      |
| 写入、事务、补偿        | 本任务只优化读；无新写入、事务或补偿路径                                            |
| 限流                    | 不新增限流；通过减少回源降低 PostgREST 压力                                         |
| 可观测性                | 不逐请求新增高频日志；用 Sentry span count/ratio、p95、5xx 和 dropped outcomes 验收 |

Supabase JS 2.107.0 已包含 GET/HEAD 瞬时错误自动重试。应用不叠加重试，防止同一次故障被 SDK 重试、前端 React Query 与页面并发进一步放大。

## 7. 最小充分方案与拒绝项

- 不引入 Redis、第二级缓存、DataLoader 框架或新的依赖。
- 不创建 Profile 聚合端点或 shared contract；这会扩大跨层和失效范围。
- 不缓存完整用户行；避免邀请归因、轮次统计等可变字段陈旧。
- 不为 runtime config 增加 TTL；本次只消除同时在途的重复读取。
- 不调整数据库 schema/index、Supabase retry、Prisma pool 或 LLM deadline；现有证据不足以支持这些变更。

## 8. 演进、发布与恢复

- 无 migration、无数据回填、无部署顺序耦合；单独发布 Backend 即可。
- 发布前用本地测试证明并发、失败清理、类型边界和 payment fallback。
- 发布后至少观察一个同流量时段；按 release 比较 `users` / `runtime_config` span 与 authenticated `http.server` 的比率，避免用绝对 count 误判流量变化。
- 停止条件：5xx、认证失败、支付套餐 503 或 runtime config fallback 日志显著增加，立即回滚 Backend deployment。
- 回滚为应用版本回滚；无数据库恢复。若仅 payment bundle 异常，可 forward-fix 恢复原四路读取，身份缓存与其互不依赖。

## 9. 可验证性

自动化必须覆盖：同用户并发合并、不同用户隔离、失败后重试、TTL/容量；runtime 单键/键集合并、自定义 signal 隔离、失败清理；payment 有效/缺失/损坏配置。

人工场景：Profile 首次进入与返回、消费明细、角色进入聊天、最新角标、签到、支付套餐正常和 503 降级。由于没有 UI/契约变化，不新增 UI fixture；复用 `packages/ui-tests` 的 `@profile` / `@roleplay` 仅作为可选回归，不冒充真实 production/Supabase 验证。
