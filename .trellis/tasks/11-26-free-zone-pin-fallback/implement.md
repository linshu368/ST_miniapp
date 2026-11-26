# 执行计划

## PR1 保上（分支 codex/free-zone-pin）

1. shared：`AdminFreeZoneStatusModel.pinned`、`AdminFreeZonePinRequest/ResponseSchema`；shared 测试。
2. backend：lifecycle / repository（读 pinned、savePinned、手动下架清 pinned）/ unroutable-guard（保上跳过）/ manual-pin.ts / 路由 / admin-status。
3. 回归测试（计费无关，但是自动下架的状态转换，按风险补）：unroutable-guard 保上跳过；manual-delist 清保上；manual-pin 未在架顺手上架、上架失败保留标记。
4. admin-client `pinFreeZoneModel`；admin 状态面板按钮与标签；CLI `free-zone pin` + coverage + README。
5. docs：ARCHITECTURE 畅聊段、registry 备注。
6. 验证：`pnpm --filter @miniapp/shared test`、backend `vitest run src/features/free-zone`、`pnpm -r typecheck`、`pnpm lint:complexity`、`pnpm lint:backend-logging`、admin build、admin-cli test。

## PR2 畅聊兜底通道（分支 codex/free-zone-fallback）

1. 迁移 `20261126_free_zone_surplus_fallback.sql`，本地 PG17 用现有 harness 验证：
   - 新重载能写 surplus 兜底、拒绝其他 provider；
   - 旧三参调用不变；
   - 补丁后 Surplus 兜底交付不碰首发记录，Surplus 首发交付照旧记录；
   - 重跑跳过。
2. shared：`FreeZoneFallbackSchema` + `free_zone_config.fallback`（default null）；测试旧配置可读。
3. backend：
   - TransportModel.surplusRoute、firstTokenPolicy.fallback；
   - resolved-model；first-token-fallback；generation-dispatch（含重写）；
   - upstream 头可覆盖；prepare 取兜底思考参数；
   - GenerationObservationRepository 调新重载（兜底为 openrouter 时也传，统一走新函数）；
   - call-ledger ownsAttempt；stream-recovery 记 request_id；call-costs Surplus 请求号补查。
4. 回归测试：
   - execute.test：畅聊首字兜底发往 Surplus，请求头和白名单正确，没有 X-Min-Discount；
   - 付费轮次仍走 OpenRouter；
   - 重写同目标；
   - 首发 Surplus 并行时兜底不改首发路由；
   - call-cost-rules 与 call-costs 的 Surplus lookup 分支。
5. admin：畅聊兜底卡片；模型目录兜底改名；畅聊页提示文案。
6. 验证：
   - 同 PR1，加上迁移 harness；
   - TEST 环境：配置 fallback，用测试账号发畅聊，人为让首发超时（候选首发等待调到很小），核对 attempts、llm_calls 和交付。
7. 发布顺序见 design.md。

## 停止条件

- 迁移守卫 md5 不符：停下，把差异报给用户，不改写。
- TEST 上 Surplus 兜底交付失败、或出现 `Attempt route cannot be rebound` / 身份冲突：不发生产。
