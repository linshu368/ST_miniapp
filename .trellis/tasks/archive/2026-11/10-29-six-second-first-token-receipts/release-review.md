# 六秒首字预算与轻量回报发布核对

授权：用户明确“先上线，已有没问题就上线”，沿用先dev后生产与CI通过管理员合并授权。本清单可直接提交发布，不重复请求审批。隔离checkout /private/tmp/st-first-token-delivery，原项目未修改；dev基线7a2a05a/main a2852ee。

## 变更与边界

- 生产运营目录97已由用户发布启用型号2秒触发、6秒总上限，本发布只读核对、不覆盖配置。默认总限6秒，新型号默认4秒。
- 首发继续竞争、赢家取消败方、单次交付与扣费沿用昨日实现；不重做已修复的连接争抢/传输。
- SSE可选冻结deadline：旧目录缓存按原点击时钟修正，不能重新计时；首终态不可改写。
- 原每轮一次结果API加浏览器本地未确认回执，用户隔离、20条/24h，无正文/凭证。最多3次即时尝试+剩余至总4次；每次3秒覆盖排队/body。联网/前台/启动最多串行4条、30秒冷却，无轮询。
- 无消息编号的v4非成功回执只用原request_id，既有索引最多读取2条且校验用户/会话，唯一才定位；歧义拒绝。重放不UPDATE，首次终态不覆盖。无新表/索引/cron/逐token写/历史回填，正常收费一次、系统超时免扣不变。
- 进程强杀且未产生终态仍可能缺报，不能制造客户端成功；已终结历史账单不追扣。

## 本地验证

- Shared186、Frontend502、Backend1033、Admin121全部通过；全部workspace typecheck、Frontend/Admin构建、lint/imports/legacy/migrations及diff检查通过（原有图片与大bundle警告保留）。本机同时构建时发生无关测试调度超时，减少测试并行后全量通过，未放宽产品超时。
- 真实PG17/PostgREST完整harness通过：迁移两次应用、跨用户/会话拒绝、无身份成功拒绝、唯一/歧义解析、首次终态后ctid不变、5999ms成功/6000ms免扣、重放收费一次，以及既有竞争、并发计费、VIP/账本测试。
- 生产EXPLAIN（不ANALYZE）证实client_request_id索引与chat_history主键查询，LIMIT2，无全表扫描。线上无业务行扫描。
- 精确任务module payload/SHA校验通过；全局模块baseline因原有drama-experience.md缺少“当前状态”章节失败，与本次代码无关，不扩展修复范围。

## 发布与恢复

单文件20261029_first_token_receipt_recovery.sql先TEST→合dev/TEST实际流验收→生产同迁移→仅本提交进入main→核对Backend/Frontend/Admin实际版本与配置→Grafana只改解释文本，7查询/5m刷新保持。现有函数CREATE OR REPLACE保留ACL，无表变更/扫描。应用回退保留SQL兼容能力，不回滚旧账务。

## 文件清单与摘要

- `.trellis/tasks/10-29-six-second-first-token-receipts/check.jsonl` — 47b5c4df8babfc2ad80ca937c0ff7210c058f99a530658ea861d733a60ccb060
- `.trellis/tasks/10-29-six-second-first-token-receipts/design.md` — 905631bfa09217ec6ff1cf3e03b0d94161274cbd3935e3d5302f336d7bc0b5b6
- `.trellis/tasks/10-29-six-second-first-token-receipts/implement.jsonl` — 47b5c4df8babfc2ad80ca937c0ff7210c058f99a530658ea861d733a60ccb060
- `.trellis/tasks/10-29-six-second-first-token-receipts/implement.md` — 303d1df2a58bd963951383dfcec6bf7b91567215553d19e3e29c994055a2c2d1
- `.trellis/tasks/10-29-six-second-first-token-receipts/module-updates.json` — b629001aafe470635fb43b3a7b4e4b6b85ab075b0eea18471157d73eed2e2466
- `.trellis/tasks/10-29-six-second-first-token-receipts/prd.md` — cd7878e14bcd76638141f94c8acd7e00875ea74638958da74b70dea5c4553f8a
- `.trellis/tasks/10-29-six-second-first-token-receipts/task.json` — 9f0cb5bc07d01ac15fa58c535f7a5ef8f5d4c0beb45138ebf1b9b245e2caf6ee
- `.trellis/tasks/10-29-six-second-first-token-receipts/task.md` — 055a4c7602cb2e1069968f2a46cea6bcec4d7b7476a86e1483fc9a0e11abcc95
- `packages/frontend/src/lib/api/first-token-reports.test.ts` — 9721eeed2e0f2b8edccb06a4e21151f4d0c27e8c15be2315a12721931472fb42
- `packages/frontend/src/lib/api/first-token-reports.ts` — 99178bc08ea6b926d511184d9ae4a0fd6888544d94918c6cffa38c8755015c94
- `packages/shared/migrations/20261029_first_token_receipt_recovery.sql` — d38d0d05b175f17c2856f9e0982acc9d307be3539eebf3d07974770e72fc5080
- `README.md` — e6265e3a2c98042f66aba6f90fc9fadcacd8a0ff98bb2c4827983da748db226a
- `docs/ARCHITECTURE.md` — 7779f4633447686082eb7544f14c23d5e26d2e21f5123db6b10ef9327aa7b815
- `docs/first-token-fallback.md` — 8d7db6fd29772e0a8ed6f44917bb13d24d24bec993767c16e48b431ae195a9e6
- `docs/grafana/chat-first-token.json` — 1417d2dacecaf0fc68777ef5abac8ee24660229cc679480b73f010564ab75c8a
- `packages/admin/src/components/FallbackConfigEditor.tsx` — 7b92af5eb6edb08ccabda4d23eb436d4795b701f0f66d35fe3f680f7c4242935
- `packages/backend/src/features/conversations/generate.lifecycle.test.ts` — b2dc065357e96150d3a60ad21d43e32ba84cb33b10e77066c2d207479198a2f8
- `packages/backend/src/features/conversations/generate.ts` — fb5c68f253ce25f1b1aaa1af9139dff58611944d625a706a45bbe4df3f5c07e4
- `packages/frontend/src/app/providers.tsx` — f27e97f44ca6aad56ad4e7fa60728fe0550e070cbd6168171dcb6dd64ddeadc8
- `packages/frontend/src/hooks/use-conversation-turn.test.ts` — a8bd42160b1585487df563e74cade8da67f327da534134d2a779d3e3f79af76e
- `packages/frontend/src/hooks/use-conversation-turn.ts` — d9d7c153ae04d8591c1bce6f4eeeb570da20aeb587c87b5cab929fb4eee34414
- `packages/frontend/src/lib/api/client.retry.test.ts` — 8f34af806d81b04c4ade0d77a3b19d092a8b5a4ea629cde2128153cfd5e7171a
- `packages/frontend/src/lib/api/conversations.ts` — 4a0253a8cdd4662e2362d291f88a0f4cb0f3bbe21befdda8d262c9426cb24514
- `packages/frontend/src/lib/perf/first-token-observation.test.ts` — 32363bd7b9b979a029599ecd0e1d8afb6e6fe2041137124d8466c6696480a622
- `packages/frontend/src/lib/perf/first-token-observation.ts` — 2b99a80b845196b32890c64059e08b2126530235ac2e615a1343d679da5122f7
- `packages/shared/migrations/tests/recoverable_chat_delivery.sql` — 86aa68e6b5357b4932a612f9f50ec66cdc38b6c6ec05ac301262eeedea0e27b8
- `packages/shared/src/__tests__/models.test.ts` — 9710d07e2defec2d4c900f737fef6492ab90d1af948ac106af02acf915637aee
- `packages/shared/src/__tests__/telemetry-contract.test.ts` — 790fa2e7e76bd0cc8ba928ae4bbec1387f5f405bfc1a2c4631733b0dcd3b4835
- `packages/shared/src/api/conversations.ts` — d9821283b2c218b715ef3a506dad444dd06745cd063d11739e8be23fb1d3643a
- `packages/shared/src/api/generation-observations.ts` — 3ea7e6a84790526c16bfc13d027d3594e4e5706742a04d0272bfbb5603b03c86
- `packages/shared/src/api/models.ts` — 9cee8004d654f0d1a444fefa6c3bcaea401e7b7d84b7e5da3629ad080ffcecf7
- `scripts/test-first-token-fallback-local.sh` — 16680285ff47cb33bb132a88725836a45bc539d65b9d67d270fb3c17fcd5d3f9

本release-review.md随清单一并提交；发布记录在本地独立证据文件中核对。
