# T8 验收记录（2026-09-24）

T7 按产品确认的 TEST 真机结果关闭。T8 复跑本地门禁，并把既有 TEST 证据和文档同步收口。本轮没有连接 Production，没有读取业务行，没有补执行 migration，没有改功能开关。

## 命令

| 命令                                    | 结果                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @miniapp/shared test`    | 11 files / 97 tests 通过                                                                                                      |
| `pnpm --filter @miniapp/backend test`   | 61 files / 527 tests 通过。包脚本排除 `*.integration.test.ts`，本轮没有另开数据库集成测试                                     |
| `pnpm --filter @miniapp/frontend test`  | 31 files / 193 tests 通过                                                                                                     |
| `pnpm --filter @miniapp/frontend lint`  | 通过                                                                                                                          |
| `pnpm --filter @miniapp/frontend build` | 通过，包含 `/vip`                                                                                                             |
| `pnpm --filter @miniapp/admin test`     | 9 files / 56 tests 通过                                                                                                       |
| `pnpm --filter @miniapp/admin build`    | 通过。既有大于 500 kB 的 chunk warning 仍在                                                                                   |
| `pnpm -r typecheck`                     | shared、admin、backend、cs-platform、frontend 通过                                                                            |
| `pnpm lint:imports`                     | 通过                                                                                                                          |
| `pnpm lint:legacy`                      | 通过                                                                                                                          |
| `pnpm lint:migrations`                  | 通过                                                                                                                          |
| `pnpm test:migration-ledger`            | 通过。第一次因本机 Postgres socket 被沙箱拒绝；重跑只创建并删除本地临时库 `st_repo_migration_c_test`，不连 test 或 Production |

## PRD 必验路径

真机界面、购买入口、模型胶囊、媒体序号和到期消息以 2026-09-24 产品确认为准。计费、并发、履约和提醒幂等沿用 T2–T6 的自动化测试与 TEST 回读，不在 T8 重放用户账务。

| 路径                                | 证据                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 角标、月卡有效期和专项星尘          | T7 真机通过；月卡赠送与履约由支付回归和 `20260921_vip_payment_fulfillment.sql` 覆盖                                                                           |
| 周/月价格、续费顺延、四路只履约一次 | Backend payment tests；已创建订单使用下单快照。代码损坏回退是周卡 100 分、月卡 200 分。任务日志没有 `20260924_vip_plans_price_1_and_2_yuan.sql` 的 apply 记录 |
| Admin VIP策略                       | Admin tests/build；草稿、发布和非法值校验在 shared/admin                                                                                                      |
| 配置只影响后续业务                  | runtime-config 与计费快照测试；历史订单不随配置重算                                                                                                           |
| 签到基础值与 VIP 加成               | wallet/checkin 回归；UI 读取 `GET /api/vip/status` 的 `benefits`                                                                                              |
| 标准/旗舰和高级图片门禁             | models/images/conversations 回归；真机确认非 VIP 路径                                                                                                         |
| 文本折扣、免费优先和快照            | shared 定价纯函数与 backend generation 回归。展示折扣读已发布值，当前任务口径是 0.95                                                                          |
| 双钱包矩阵和原路退款                | T4 与 wallet/refund migration 回归。T8 未重放 TEST 余额                                                                                                       |
| 语音/初级图片免费次数               | 子任务与 `20260922_media_feature_free_trials.sql`；真机确认序号展示                                                                                           |
| 模型胶囊与充值互斥                  | T7 真机通过                                                                                                                                                   |
| 到期提醒与单条已读                  | 2026-09-24 TEST：`vip_reminders_enabled=true`，development Cron `--write`，插入 2 条后复跑 0 条。真机确认消息详情。Production Cron 未声明                     |
| 存量余额与旧客户端                  | T2 migration 守恒记录。T8 未再查询钱包聚合                                                                                                                    |
| Production 保持关闭                 | 本轮未操作 Production migration、开关或 Cron                                                                                                                  |

## 文档

- `README.md` 的失效日志链接改到 `.trellis/spec/backend/app/data-reliability-and-security.md`。仓库没有 `docs/log_system.md`，没有补一份平行日志文档。
- `docs/ARCHITECTURE.md` 写入 VIP 资格、策略、计费、提醒和 Production 未开通。
- Frontend/Backend 规范同步模型入口、VIP 路由、单条已读和支付履约。

## 模块知识

`module-updates.json` 覆盖任务声明的 16 个模块，`python3 ./.trellis/scripts/module_knowledge.py check 09-21-miniapp-vip-model-ui` 通过。载荷尚未 apply，任务未归档。

为让校验器能解析现有模块文档，本轮去掉了模块文件的 UTF-8 BOM，并给 5 个在 Batch Lab 移除时丢掉 `last_verified_task` 的文件补回移除前的任务引用。这只恢复校验元数据，不恢复已删除的 Batch Lab 正文。

## 未做

- 未 apply 模块载荷，未归档任务。
- 未把 T9 Production 发布单写成已批准。
- 未 commit，未 push。
