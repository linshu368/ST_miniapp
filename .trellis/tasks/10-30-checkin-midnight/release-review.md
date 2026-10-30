# 签到零点更新：最终提交审阅

## 最终行为

北京时间每天00:00恢复签到。今晚23:50已领，次日00:00可再领；同一天重复/并发只能成功一次。VIP、新用户、老用户奖励金额沿用运营配置，不清空余额。个人中心提示每天00:00更新，停留跨零点会回读服务端资格。

## 范围与发布

分支codex/checkin-midnight，基于main 8cbd10fe4ca5d728648a0d2d3150cce70f0704ce。只包含本次签到业务、对应页面/固定验收和发布文档。先合dev验收，再将同一功能独立合main；不整包发布dev，不合入其余功能。数据库经既有workflow先TEST后生产，再部署Backend/Frontend。

拟提交：`fix: reset daily check-in at Beijing midnight`。下列路径为完整拟提交清单，无不明归属修改。审阅文件本身亦属于该提交；最终内容另由本地快照校验，提交前不改写。

## 验证

shared196项、wallet/VIP backend25项、profile hooks10项、fixture7项通过。隔离PG17全套VIP计费及自然日/并发/重放通过；手机验收12项通过，hook依赖修正后零点用例再次通过。workspace类型检查、frontend生产构建、迁移命名、legacy guard、shell语法、模块载荷和差异静态检查通过。真实TEST/生产迁移及远端CI尚未执行。原有图片标签/Browserslist构建提示未混入修复。

## 文件摘要（SHA-256）

| 文件 | SHA-256 |
| --- | --- |
| `.trellis/spec/database/supabase/migrations-and-rollbacks.md` | `317c99a9da3e055828ebef5176ec1a783d389e3c8fef6272100c57132d97f00d` |
| `.trellis/tasks/10-30-checkin-midnight/check.jsonl` | `b095cffd753b2a3c18e6ceda7435f791737e54603498b08ae0625a4d33ed451c` |
| `.trellis/tasks/10-30-checkin-midnight/design.md` | `8d2e4c295ce803f7a181dae9e1a9547715b44cc4c0b286e6f1dfaa9c4f0c513a` |
| `.trellis/tasks/10-30-checkin-midnight/implement.jsonl` | `b095cffd753b2a3c18e6ceda7435f791737e54603498b08ae0625a4d33ed451c` |
| `.trellis/tasks/10-30-checkin-midnight/implement.md` | `601b4394c89e08aa29d7b05d486efcac42590b2bdbd67a76a71679fe3fad0ced` |
| `.trellis/tasks/10-30-checkin-midnight/module-updates.json` | `65ffea5f18d4dae74bc319e044b001694a57b4110b636d00dedf5a2beaeebe66` |
| `.trellis/tasks/10-30-checkin-midnight/prd.md` | `93e660e14d6b89473a9137bd0c519f7e3e87d5d254ba525363b28e7f17e74a55` |
| `.trellis/tasks/10-30-checkin-midnight/task.json` | `d9910e62ebfba86104c9156cf750115b43136bd57c2baf232d0762bf8ac37709` |
| `.trellis/tasks/10-30-checkin-midnight/task.md` | `f1b439c62e287dff6a0838650a3c2dbad0160a02c9e943b09c2deb79e4cec514` |
| `.trellis/tasks/10-30-checkin-midnight/verification.md` | `2feb27bde9bf0b4c2f108979e14c7b206acee21161cd7a55886fe697aa2415ea` |
| `README.md` | `dfedbd41b27c37ecf1b011edcf0a915527eb040d4e42c85ba626cb56d3f021e3` |
| `docs/ARCHITECTURE.md` | `0d1c031e67ebe38565ccf3a1f7475fe3776baa048b1651e80aff38008c6d64ce` |
| `packages/backend/src/infrastructure/repositories/MiniappWalletRepository.ts` | `8c35e3ade1aa695f71def2e86d1f4d49654e0cd1c0c04f9f36f005a2bcfa98fa` |
| `packages/frontend/src/app/(main)/profile/page.tsx` | `5462fefcba5c9c3006e23936962e76bee2420ee55803a221011c18016beff60a` |
| `packages/frontend/src/lib/api/payment.ts` | `502f5a9d1f102f58a7ecdf868ea1d437af0f2a7704f7a1a91b2fc8bec767aed9` |
| `packages/shared/migrations/20261030_checkin_calendar_day.sql` | `e8bd2a090c72a3a987ab6cf9e0b30dae3e3ecfc95003d67e3a805935226d5b6f` |
| `packages/shared/migrations/README.md` | `66d28dfdc5f179e72621fe512f735e4560ebff98fc215fa21469cd7ae17c974f` |
| `packages/shared/migrations/tests/vip_checkin_tiered_t3b_scenarios.sql` | `42006593d8dd097242a2e79c2949a04edef2d6ef4ce279425db5e0c7872785be` |
| `packages/shared/src/__tests__/vip-billing-contracts.test.ts` | `1858a4f9ec82c7ea1c10ad2deb9f2e91740f59cd461ac01dd11ed2977dd4550a` |
| `packages/shared/src/api/wallet.ts` | `54a05d50f71dd4ba13e705ced890582141a3d18d719b0d35602e68fa9169f46e` |
| `packages/ui-tests/README.md` | `9537e499a64f2e21d893efb3e26928dca534482a6be423aae6230506424f36a2` |
| `packages/ui-tests/fixtures/server.test.ts` | `4864a9fb125c70db123451a4e1bc4528fae34a7d4650798bdd61786bcee72c63` |
| `packages/ui-tests/fixtures/server.ts` | `d54904b048f15a42b0c694ed7e4685ba9b8ed6883f2d5cbacc08695e135e3a0c` |
| `packages/ui-tests/tests/profile.spec.ts` | `6141d803b6b2f16e5da10830a8bf2c32432347908f9ccc5aee04c73b539131fe` |
| `scripts/test-vip-billing-migrations.sh` | `f1c677458221d90b607523de5449bd561413bc6ca92091769f633283db1b0243` |
| `.trellis/tasks/10-30-checkin-midnight/release-review.md` | 本审阅文档，纳入最终快照校验 |
