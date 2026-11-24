# 技术设计

## 删除

| 位置                       | 内容                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| backend/features/free-zone | `evaluation-job.ts` `screening.ts` `probe.ts` `probe-screening.ts` `admin-preview.ts` `manual-pin.ts` 及测试；`lifecycle.ts` 缩成手动上架 / 下架两个状态转换；`repository.ts` 去掉评估、质量、保上读写 |
| backend 其它               | `app.ts` 任务启停、`types.ts` 的 `maxUnroutablePct`、`routes/admin-free-zone.ts` 的 screening / pin                                                                                                    |
| shared                     | `FreeZoneScreeningSchema` 只留 `min_discount_pct` `blocked_providers`；删 `on_shelf` `relist`、筛选预览 / 保上 / 逐项检查 / 探测契约                                                                   |
| admin / admin-client       | `FreeZoneScreeningPanel` `FreeZoneScreeningOptions` `FreeZonePinButton`；`FreeZoneConfigEditor` `freeZoneForm` `FreeZoneStatusPanel` 对应字段                                                          |
| admin-cli                  | `free-zone screen` `free-zone pin`，README 与 coverage                                                                                                                                                 |

## 保留与改法

- `unroutable-guard.ts` 保留入口，判定改为「连续拒单 10 次且首尾相隔 ≥10 分钟」固定值，不再有运营参数。
- `surplus-market.ts` 只留报价簿读取，供手动上架选供应商；性能接口读取删除。
- 配置键名 `screening` 不改名：线上值（折扣底线、屏蔽渠道）直接可读，多余的旧键由 zod 丢弃。
- 在架判断仍是 `features.free_zone_models.status = 'listed'`；`cooling` / `unlisted` 都按未上架处理，存量行不改。

## 数据库

第一步只改代码，不动表。发布稳定后另做收缩迁移：删 `free_zone_models` 的 `pinned` `excluded_providers` `consecutive_passes`
`cooldown_until` `business_delists_at` `last_metrics` `evaluated_at`，并处理依赖的 `analytics.free_zone_model_states` 视图与 Grafana 面板。

## 风险

- 计数在进程内，多副本各算各的；重启清零，只会晚一点下架，不会误下架。
- 已保上的在架行 pinned=true 仍留在表里，新代码不读，连续拒单照样会下架（用户确认）。
- 另一会话当天刚发过畅聊上限改动（#1145），以最新 dev 为基线，避免冲突。

## 发布与回滚

feature → dev → 从 main 拉发布分支 → main；后端与运营平台同批。回滚 = 回退代码，表未动，旧评估任务 30 分钟内恢复推进。
