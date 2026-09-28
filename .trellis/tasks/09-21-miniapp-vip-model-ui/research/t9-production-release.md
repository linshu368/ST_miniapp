# T9 Production 发布单（2026-09-24）

## 1. 发布结论与边界

- 产品已确认 TEST 真机 VIP 验收通过，并于 2026-09-24 明确进入 Production 发布准备。
- PR #345 已合入 `dev`：merge commit `eeff2b641cd0c0a103827dba5072a60843f825f3`。
- T9 检查时 `dev` / `origin/dev` 为 `0282db762b6a24980b2678b29a3ee15251816c66`。创建并合并 `dev -> main` PR 后，以下所有部署和 smoke 必须改用最终 main merge SHA，不能继续把此 SHA 当成上线 SHA。
- 本发布单只授权形成顺序、前置、校验、开关和恢复方案。本轮没有 apply Production migration、没有执行 Railway apply、没有修改 Production runtime config，也没有读取业务行。
- `dev -> main` 不是 VIP-only 差异：还包含 preset platform、Batch Lab 移除、支付商品名与 PR #345 后两笔聊天提示修正。开 PR 时必须按完整 diff 审核，不能把整包描述成只有 VIP。

## 2. Production 只读基线

- 目标：Production Supabase `wbtsfzozlmurljvglhpn`。
- 证据：[Database Migration inspect run 35986272758](https://github.com/linshu368/ST_miniapp/actions/runs/35986272758)，checkout `dev@0282db76`，2026-09-24 18:17（Asia/Shanghai）成功。
- 结果：dated migration 共 34 个，`not_applied=25`，`drift=0`。当时下列 13 个原始 VIP migration 全部 `not_applied`。
- 2026-09-24 首次 Production apply 证实两个历史文件不能直接使用，且均事务回滚：`20260914_chat_message_images.sql` 因现存 `image_text_model_config` 不在其旧 Admin 白名单而失败；`20260921_vip_billing_schema.sql` 因已存在 `cron.job` 而失败。前者的表和索引已存在但无 ledger，后者未留下 VIP schema。
- `20260914` 与 `20260921` 因此是已知账本例外，不得重试、不得用 `force_rerun`、不得删除 `image_text_model_config` 或卸载 pg_cron。改由本单的结构门禁与 `20260924_vip_billing_schema_pg_cron_compat.sql` 覆盖。
- 明确不随本发布执行：`20260914_chat_message_images_rollback.sql`、全部 Batch Lab migration、`20260912_backfill_character_persona_and_style.sql`，以及本单未列出的其他 `not_applied` 文件。

## 3. 上线前置门禁

1. `dev -> main` PR 的最终 reviewed head 必须包含本发布单、Production VIP reminder Cron IaC，以及下面所有 migration；CI 全绿后记录最终 main merge SHA。
2. 在合并前冻结 Admin 的 Production VIP 策略编辑，确认当前没有并行数据库发布或 Railway production apply。
3. 先在 Production SQL Editor 做以下只读结构门禁（不查业务行或配置值）。任一图片对象缺失、bucket 不符合既有 migration 约束或 `image_text_model_config` 不存在，停止并另开图片 schema 修复，不把历史 `20260914` 重跑。

   ```sql
   SELECT
     to_regclass('experience.chat_message_images') AS chat_message_images,
     to_regprocedure('experience.claim_chat_image_jobs(text,integer,integer)') AS claim_chat_image_jobs,
     to_regprocedure('billing.settle_image_generation(uuid,uuid,numeric,jsonb)') AS settle_image_generation;

   SELECT id, public, file_size_limit, allowed_mime_types
   FROM storage.buckets
   WHERE id = 'miniapp-chat-images';

   SELECT source, config_key, row_count
   FROM (
     SELECT 'drafts'::text AS source, config_key, count(*) AS row_count
     FROM admin.config_drafts
     GROUP BY config_key
     UNION ALL
     SELECT 'releases'::text AS source, config_key, count(*) AS row_count
     FROM admin.config_releases
     GROUP BY config_key
   ) AS config_key_counts
   WHERE config_key = 'image_text_model_config';
   ```

4. 回读 Production 当前 `vip_purchase_enabled`、`vip_reminders_enabled`、`image_generation_enabled`、`image_advanced_enabled` 和对应 version；新开关不存在视为 false，不得猜测为已开。
5. 确认 Production 支付四路、Backend/Vercel URL、CORS、Supabase production 变量、图片/语音供应商变量均指向 Production。不得把 TEST 值复制到 Production。
6. 高级图片继续关闭：`image_advanced_enabled=false`。只有 provider/model/price/secret 全部单独验收后才能另行开启。
7. 任一出现 schema 前置不一致、checksum drift、并行 migration、锁等待超过文件预算或生产配置来源不明，停止发布。

## 4. Production migration 顺序

统一从 GitHub Actions `Database Migration` 在受审 commit 上执行。每次只选择一个文件：

- `mode=apply`
- `environment=production`
- `confirm_production=RUN_PRODUCTION_MIGRATION`
- `force_rerun=false`

每个文件成功后记录 Action URL、实际 SHA、耗时和自检结果；失败立即停止，不跳到下一文件。顺序不得按文件名字典序替代：

| 顺序 | migration                                          | SHA-256                                                            | 目的 / 前置                                                                   |
| ---: | -------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
|    0 | `20260924_vip_billing_schema_pg_cron_compat.sql`   | `65759a91a3e34338111c705c11374c26920f71454ccc2a2dc344ed1730fdf25c` | 替代不可重跑的 `20260921`；仅在零 VIP 表时执行，保留 pg_cron，不创建 Cron job |
|    1 | `20260921_wallet_debit_refund.sql`                 | `e67d3e807f8806792ac18af6330117feda9109d2d12287c436ce665cbc85c5e3` | 双钱包原子扣款与原路退款                                                      |
|    2 | `20260921_feature_free_trial_checkin_reminder.sql` | `f8366f8ed77e97f7c6e498207d1cbcb187795d8efdd58c06d30221c5a2cbcc2c` | 免费额度、签到与提醒基础函数                                                  |
|    3 | `20260921_vip_payment_fulfillment.sql`             | `bd32e8c4e2009dcda8c41dbc491e2a5ad120c759ecef964695e2ae3d3a3772c3` | VIP 支付幂等履约                                                              |
|    4 | `20260922_daily_checkin_vip_bonus.sql`             | `bd1168500f8e70587693ee28a7e6c3d7f1cf0bf0da91fd0160453d1d0c21e875` | VIP 签到加成                                                                  |
|    5 | `20260922_invite_first_paid_vip_fulfillment.sql`   | `4b42cc04be536392a4c5ccc35c3e53c064f14a098f0e2531fdf76cc0ba48cf11` | 首次现金支付兼容 VIP 履约                                                     |
|    6 | `20260922_llm_vip_wallet_charge.sql`               | `99f63f2e523eb72ca66db12a0ec519973f4ac42b113d36de405a3d3c42f87241` | LLM VIP 折扣、钱包与退款函数                                                  |
|    7 | `20260923_vip_strategy_config.sql`                 | `7fe41b2b435c4cb33305c77acab720aee593105e167db46b23d99ef32ced5f3d` | 先建立 VIP 商品、折扣、签到和分功能免费额度配置；保持与 TEST 已验证顺序一致   |
|    8 | `20260922_media_feature_free_trials.sql`           | `aa2fdca6d8402fc14e48f80eccfe64c9b58ba417b38b3a794a96fd4167f509f4` | 语音/图片免费体验和高级图片快照                                               |
|    9 | `20260923_admin_vip_media_config.sql`              | `83d758e51c916d66422044e82164bc26759aa7eb701f5aea789333eba6339169` | Admin 媒体配置；随后必须紧接 alignment                                        |
|   10 | `20260923_vip_strategy_media_limit_alignment.sql`  | `e309b460ed19efb3cd072d2775ca80aea148c97c8bdedd95f10013aba01e51cc` | 恢复按功能读取上限并收紧 ordinal 到 1..20                                     |
|   11 | `20260923_vip_expiry_reminder_dispatch.sql`        | `364b17c747204cb02d61e381cf7a46f8a1148f84f9c5d9f4a1c540bb17760eb6` | 到期提醒候选与幂等写入 RPC                                                    |
|   12 | `20260924_vip_plans_price_1_and_2_yuan.sql`        | `22f6d4dbed65fbdc2ed537b1c5fb8cabc2a6807553eb05d2efdd648e22ecb62c` | 已发布周卡 100 分、月卡 200 分；不改历史订单快照                              |

完成后再次运行 Production `inspect`。验收条件是兼容 migration 及表中其余 12 个文件 `match / applied`、`drift=0`；`20260914` 与 `20260921` 保持已记录的 `not_applied` 例外，不能被误报为本次失败。未列出的 absent 文件继续保持原状。

## 5. 应用与 Railway 发布顺序

1. 在 `dev -> main` PR 已批准、但尚未合并时，先从同一 reviewed dev commit 按 §4 执行 migration；所有开关保持关闭。这样旧应用仍可运行，避免 main 自动部署的新 Backend 先于 schema 到达。
2. migration postflight 通过后合并 PR，记录最终 main merge SHA。
3. 等待 Railway `stminiapp`、`stminiapp-payment-reconcile-cron`、`stminiapp-payment-cron` 和 Vercel Frontend/Admin 全部部署同一 main SHA；任一失败不打开 VIP 购买。
4. 使用 `RAILWAY_CONFIG_ENV=production railway config plan --file .railway/railway.ts --verbose`。T9 首次 plan 为 `1 add / 8 change / 4 destroy`，发现 `LLM_PROXY_TOKEN_SECRET`、`ST_BASE_URL`、`ST_PROVISION_URL`、`ST_USER_PASSWORD_SECRET` 会被误删，因此已补入 `preserve()` 并禁止使用该旧 plan。第二次只读 plan 为 `1 add / 8 change / 0 destroy`。新增项是 `stminiapp-vip-reminder-cron`；8 个 change 是支付 Worker/Cron 的 `DATABASE_URL`、`DIRECT_URL`、`PROD_DATABASE_URL`、`PROD_DIRECT_URL` 从独立保留值对齐为 `stminiapp` 引用。上线前须确认引用解析到同一 Production 值；如不能确认，停止并只创建提醒服务，不顺带改支付资源。
5. plan 人工确认后执行 production `railway config apply`。新 Cron 连接 `main`，每小时第 20 分运行 `send-vip-expiry-reminders.ts --write`；此时 `vip_reminders_enabled=false`，所以不会插入通知。
6. 在开关关闭状态 smoke：`/health`、登录、`GET /api/vip/status`、支付套餐目录、钱包、模型目录、语音/图片配置、Admin VIP策略、通知列表/详情；确认周卡 1 元、月卡 2 元、95 折和 60/120 展示来自服务端。

## 6. 分项开关与 Production smoke

1. **购买**：只把 Production `vip_purchase_enabled` 从回读的旧 value/version 条件更新为 `true`，立即回读。使用生产测试账号支付周卡 1 元，核对订单金额快照、四路只履约一次、会员期限、月卡赠送不适用于周卡、钱包/ledger 无重复。异常立刻关购买。
2. **文本与语音**：验证非 VIP 只能轻量、VIP 可选三档、95 折实扣、轻量 main-first+bonus、标准/旗舰/语音 paid main-only、失败释放/退款。任何余额不守恒或重复扣退立即停止对应能力与新购买。
3. **基础图片**：只有 Production provider/Storage/secret 已核且一次完整 ready→Storage→settlement 成功时，才将 `image_generation_enabled` 打开；否则本次保持 false，不阻塞 VIP 购买。免费序号、失败释放和 main-only 以服务端事实为准。
4. **高级图片**：本次固定 `image_advanced_enabled=false`，不做灰度。
5. **提醒**：先在 Production 环境手工运行一次 `--dry-run`，记录 `scanned/eligible/failed/duration`，不得记录用户明细。规模与耗时合理后才把 `vip_reminders_enabled` 条件更新为 `true`；观察首轮 Cron，立即复跑应不产生重复 business key。异常关开关并停 Cron。

## 7. 停止与恢复

- 停止条件：余额不守恒；重复履约、扣款、退款或提醒；VIP 权限绕过；免费次数超领；已售权益丢失；支付金额/商品快照不匹配；migration checksum drift/锁超时；Production 配置或部署 SHA 不一致。
- 首要恢复动作：关闭 `vip_purchase_enabled`、`vip_reminders_enabled`、`image_generation_enabled` 和 `image_advanced_enabled`，停止新增受理；保留已完成订单、会员、钱包、ledger 和通知事实。
- migration 均按 additive/forward-fix 恢复，不执行 rollback 文件、不改写已 apply migration、不手工更新钱包。
- 一旦 Production 已售出 VIP，不得把 Backend 回滚到不认识 VIP 订单/权益的版本。可先隐藏 Frontend 入口；Backend 问题使用兼容 forward-fix，继续兑现有效会员。
- 计费补偿只按原 debit ledger 调幂等 refund RPC；禁止直接 UPDATE 余额。

## 8. 发布完成证据

上线执行者在本文件追加：main merge SHA、13 个 migration Action URL、最终 inspect URL、Railway plan/apply 摘要、四个服务与 Vercel deployment SHA、各开关前后 value/version、支付订单内部 ID、smoke 结论、停止/恢复是否触发。不得写 token、密钥、完整 initData、支付私钥、用户正文或敏感 URL 参数。
