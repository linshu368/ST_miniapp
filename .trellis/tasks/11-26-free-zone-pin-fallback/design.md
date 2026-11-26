# 设计

分两个 PR 依次发：PR1 保上（无迁移），PR2 畅聊兜底通道（一个迁移 + 后端 + 运营平台 + 配置）。

## PR1 保上

### 复用

- 列 `features.free_zone_models.pinned`（迁移 20261123_free_zone_pinned.sql，生产仍在，11-24 起不读写）→ 重新启用，不加迁移；registry 备注把 pinned 移出待收缩列表。
- #1074 删掉的 `manual-pin.ts`、`FreeZonePinButton.tsx`、`pinFreeZoneModel`（admin-client）、CLI `free-zone pin`：从 `a61a183a^` 取回，按现在只有手动上架的语义改写。
- 连续拒单落库仍走 `saveDelisting(build)`：`build` 看到 `pinned` 就返回 null（`unchanged`），guard 记 `free_zone.unroutable_skipped`（加 `skip_reason: 'pinned'`）。在事务里判断，避免「刚保上就被下架」的竞态。

### 改动

- `lifecycle.ts`：`FreeZoneModelState.pinned`；手动下架时清掉。
- `repository.ts`：读 `pinned`；`savePinned`（锁行 upsert，只改 pinned）；手动下架那条 UPDATE 同时 `pinned = false`。
- `manual-pin.ts` + 路由 `POST /api/admin/free-zone/pin`（`@frontend-ready: false`，write 权限）；`admin-status` 返回 `pinned`。
- shared：`AdminFreeZonePinRequest/Response`，`AdminFreeZoneStatusModel.pinned`（default false，兼容旧后端）。
- admin：状态面板「保上」标签 + 按钮；admin-client `pinFreeZoneModel`；CLI `free-zone pin <id> [--off]`（走 `ctx.confirm`），coverage 登记，README。

### 旧数据

11-23 ~ 11-24 设过保上的行，`pinned` 可能仍为 true，发布后立即生效。发布后用 `free-zone status` 列出来给用户确认，需要的话用 `--off` 取消，不在迁移里批量改。

## PR2 畅聊兜底通道

### 配置（`free_zone_config.fallback`，可为 null）

```
fallback: {
  surplus_model: 'deepseek-v4.1-flash-1017',
  preferred_provider: 'mistral' | null, // 优先的供应商（Surplus provider_order），没卖家时 Surplus 自选；null = 不排序
  route_objective: 'latency' | 'reliability',   // 默认 latency（性能优先）
  price_tolerance_pct: 0..10000        // 默认 1000：比最便宜报价贵 10 倍以内都按速度排
} | null                               // null = 沿用模型目录兜底（现状）
```

- 不设 `X-Min-Discount`：Surplus 文档里不带底线时仍可派给任意报价（含原价）。
- 用户 11-26 定稿：mistral 优先、没卖家就让 Surplus 自己挑，所以用 `provider_order: [preferred_provider]`（只排序不改可选范围），不用白名单；兜底的思考参数仍按 mistral 处理（不发 reasoning，否则 mistral 400）。
- **所有 Surplus 请求永远屏蔽阿里 dashscope-cn**（用户 11-26：只要是 Surplus 平台就必须生效，可以写死）：在统一出口 `forwardToUpstream` 给 provider=surplus 的 JSON body 合并 `providers_blocked`（写死 dashscope-cn ∪ 调用方传入的）；畅聊首发与兜底另并入 `screening.blocked_providers`。覆盖畅聊、付费 Surplus、状态栏。
- 屏蔽渠道（用户 11-26 追问）：兜底请求 body 一律带 `providers_blocked = screening.blocked_providers`（现为 dashscope-cn，阿里云内容审核会把角色扮演写到一半掐断）。Surplus 文档：providers_blocked 是硬拒绝、不会放开。钉了 mistral 时本来就排除，留空供应商时靠它挡住。现状：屏蔽渠道只在手动上架选供应商时用，从没随请求发出；首发靠白名单天然排除。
- 价格带由服务端截断，文档没写上限；超出带宽的报价按便宜优先排在后面，仍可在失败时轮到。
- Surplus 文档提示：非 price 目标按可能选到的最贵报价预扣额度，余额低时可能 402。余额已有监控（surplus-balance-alerts）。

### 链路

- `ResolvedModel.firstTokenPolicy.fallback`：`TransportModel`（加可选 `surplusRoute: { providers, minDiscountPct|null, objective, tolerancePct }`）。畅聊在 `buildFreeZoneResolvedModel` 里按配置填；没配或付费轮次仍是 OpenRouter + `fallbackModelId`。
- `first-token-fallback.ts`：`startFallback` 用传入的兜底目标，不再写死 openrouter。
- `generation-dispatch.ts`：
  - Surplus 请求头和白名单从 `model.surplusRoute` 取。首发照旧由 `freeZone` 生成同样的值，行为不变。兜底不带首发的折扣底线和供应商。
  - `createRecoveryForward` 用同一个兜底目标。
  - `upstream.ts` 的 `SURPLUS_ROUTING_HEADERS` 改成可被调用方覆盖。
- 思考参数：prepare 时额外按兜底模型取一次 `getSurplusReasoningParameters(cachedOnly)`，`surplusReasoningBody(…, provider)`，mistral 照旧不发。
- 兜底调用不经 `forwardSurplusCall`，因为每轮一行的 Surplus 调用记录属于首发；直接 dispatch。
- 兜底调用不进 `noteFreeZonePrimaryCall`（本来就只记 primary）。

### 数据库（一个迁移，`20261126_free_zone_surplus_fallback.sql`）

真实故障：现在 Surplus 兜底一定会失败。

1. `prepare_chat_generation_fallback` 写死 `'openrouter'`，Surplus 兜底观测时会报 `Attempt route cannot be rebound`。
2. `select_chat_generation_delivery` 的 Surplus 分支会把兜底的 generation_id 写进首发那行 Surplus 记录：可能身份冲突、交付失败，也可能张冠李戴。

改法：

- 新增重载 `experience.prepare_chat_generation_fallback(uuid, uuid, numeric, text)`，provider 只能是 openrouter 或 surplus，其余与原函数相同。旧的三参版本保留，滚动发布期间旧进程照常调用，等收缩时删。
- 补丁 `select_chat_generation_delivery`：Surplus 分支只在 `a.role = 'primary'` 时调用 `record_surplusintelligence_call`。照现有方式校验生产原文 md5，锚点恰好一处替换，已是新版本就跳过。
- 授权与原函数一致（service_role），不给 anon/authenticated。

### 调用台账与成本

- Surplus 兜底和重写不代表 attempt 那一行：`ownsAttempt=false`，`attempt_id` 为空，避开 `llm_calls_surplus_attempt_turn_idx`。
- 重写调用补记 `x-si-request-id`。
- `call-costs`：Surplus 行没成本、有 request_id、attempt_id 为空的（兜底、重写、并发落败），按请求号查 `GET {surplus}/requests/{id}` 取 buyer cost。
  - 次数记在 `ops.llm_cost_jobs`，最多 8 次、24 小时内，每轮最多 60 次。
  - 拿不到就 `unavailable`。
  - 复用 `surplus-request-recovery.ts` 的读取与身份校验，抽出共用函数。

### 运营平台

- 畅聊页新增卡片「畅聊兜底」：模型、供应商、路由目标、价格带，写明「只用于畅聊，不设折扣底线，原价也兜底；留空沿用模型目录兜底」。
- 模型目录兜底卡标题改为「付费档位兜底模型」，提示畅聊另有专用兜底。
- 畅聊页原提示「兜底模型仍是兜底配置里的那个」随之改掉。
- managed config 自动进 CLI；畅聊专用编辑器在 `FreeZoneConfigEditor` 里接。

## 可靠性

- **超时**：兜底窗口不变。畅聊首发等待 7s，总上限 10s，兜底只有约 3s 出首字。
  - Surplus 1017（mistral）作首发时 p50 2.8s、p90 5.0s，所以「兜底也没出字」可能上升。
  - 发布后按小时看；不行可放宽总上限，或把 fallback 置空回到 OpenRouter。
- **供应商**：mistral 只是优先，没卖家时 Surplus 换别家（阿里除外），不会因为钉死而当场 404。
- **兜底时间**：用户 11-26 已把畅聊首发等待/总上限改为 6s / 11s，兜底约有 5s。
- **重试**：不新增。Surplus 自己会在卖家之间换。
- **幂等与并发**：兜底仍是每轮一次，attempt 身份不变；迁移里的函数变更是幂等的，可重跑。
- **降级**：配置读失败按 null 处理，回到现状。
- **观测**：沿用 `llm.attempt.*`、`llm.recovery.*`、`st_chat_fallback_dispatches_total{fallback_model}`、`ops.llm_calls`；新增 `free_zone.pin_changed`、`llm.surplus_call_cost_*` 汇总字段。

## 发布与回滚

1. PR1：dev → release → main，部署后列出保上标记，给用户确认。
2. PR2 迁移：GitHub Actions 依次在 TEST、生产执行，核对函数定义与授权。
3. PR2 后端与运营平台发布：没配置前行为不变。
4. 运营配置 `free_zone_config` 加 fallback：先给用户看差异，同意后发布。
5. 回滚：fallback 置空，30 秒缓存后生效。代码回退不需要回退迁移，新重载没人调用也无害。

## 拒绝的方案

- 在 `chat_generation_requests` 加兜底供应商列：热表加列，且三参函数照样写死。
- 让兜底复用首发的 Surplus 调用记录：每轮一行的设计，改了牵动计费补查和看板视图。
- 通用多级兜底框架：只有一个兜底，没必要。
