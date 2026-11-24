# 执行计划

## 复用调研

| 检索对象                                              | 结论                                             |
| ----------------------------------------------------- | ------------------------------------------------ |
| `repository.ts` `saveManualListing` / `saveDelisting` | 复用：行锁 + 条件写 + 事件，去掉评估专用列的读写 |
| `unroutable-guard.ts`                                 | 复用入口与落库，判定改为连续拒单                 |
| `surplus-market.ts` 报价簿读取                        | 复用：只在手动上架时选供应商；性能接口删除       |
| `manual-list.ts` / `manual-delist.ts`                 | 扩展：上架不再探测、不再走初筛                   |
| `admin-status.ts` / `FreeZoneStatusPanel`             | 缩减：在架 / 未上架两块                          |

## 步骤

1. shared：配置 schema 只留折扣底线与屏蔽渠道；Admin 契约缩减。
2. backend：删评估、初筛、探测、预览、保上；lifecycle / repository / guard / manual-list 改写；app.ts 停任务。
3. admin-client、admin、admin-cli 同步；README、ARCHITECTURE、registry 说明更新。
4. 测试：删对应测试，改写上下架、连续拒单、旧配置可读的测试。

## 失败路径

- 手动上架时行情拿不到 → 502，提示手填供应商；没有达标供应商 → 409，不上架。
- 连续拒单写库失败 → warn，重新计数后再试。
- 读状态失败 → 沿用上一次快照（现状不变）。

## 回滚

回退代码即可；表结构未动，旧评估任务恢复后 30 分钟内继续推进。收缩迁移另起。

## 验证

- `pnpm -r typecheck`、shared / backend / admin / admin-client / admin-cli 测试、lint、lint:complexity、lint:backend-logging、lint:db-contract、admin build。
- 上线后：`pnpm -s admin free-zone status --json` 两个在架模型与供应商不变；Railway 不再出现 free_zone.evaluated。
