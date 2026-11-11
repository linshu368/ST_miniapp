# 设计：畅聊栏目第一版

基线：origin/dev `d029031e`。生产现状：目录里还没有 Surplus 模型；首字总上限 5s；每个模型的兜底启动时间是 2s；兜底模型 1017 走 OpenRouter。Surplus 调用明细的记录（#717）已在 main。

## 1. 复用调研

| 已有能力            | 位置                                                                                                                        | 处理                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公开模型目录 / 选择 | `routes/models.ts`、`text-billing.ts#resolveTextModelSelection`                                                             | 扩展：目录返回里加 `free_zone`；选择解析加「免费模型不可用就自动换」。照搬现有 VIP 过期回落轻量的懒替换做法：读的时候发现不可用，就写回新的选择并记日志。 |
| 自己的角色卡判断    | `creator-billing.ts#getCharacterCreatorOwner`（现在的「自用」折扣已经在用）                                                 | 复用                                                                                                                                                      |
| 首字策略            | `resolve-model.ts`（主模型超时、兜底预留、总上限）、`turn-preparation.ts`                                                   | 扩展：免费模型用栏目配置覆盖「主模型超时」和「总上限」                                                                                                    |
| Surplus 请求        | `upstream.ts` 构造请求体、`surplus-call-transport.ts`                                                                       | 扩展：加 `X-Min-Discount` 头和 `provider` 白名单。只对免费模型生效                                                                                        |
| Surplus 调用明细    | `experience.surplusintelligence_chat_history`（#717，包含实际扣费 buyer_cost_micro）                                        | 复用：平均实际价格用它算                                                                                                                                  |
| 首字事实            | `experience.chat_generation_attempts` / `chat_generation_requests`（`miniapp_analytics.chat_first_token_facts` 视图的来源） | 复用：没出字、兜底交付、超时、首字 p90 都从这里算                                                                                                         |
| 点踩                | 回复反馈（#724）                                                                                                            | 复用                                                                                                                                                      |
| 后台定时任务        | `lib/lobby-ranking-refresh-job.ts`（多副本用 advisory lock，`observeBackgroundRun` 记录执行情况）                           | 照搬模式                                                                                                                                                  |
| 运营配置            | `admin-client/configSchemas.ts` + `menu.ts`，CLI 自动支持                                                                   | 新增一个配置键                                                                                                                                            |
| 扣费                | `quoteTextModelUsage` 已有算出 0 的路径（旧免费轮次在用）                                                                   | 复用「扣 0」这条路径，但用独立的「畅聊」类别，不和旧免费轮次混在一起                                                                                      |
| Surplus 公开接口    | 不需要鉴权                                                                                                                  | 新写一个小客户端：8s 超时，失败不重试，等下一轮                                                                                                           |

## 2. 数据

### 2.1 运营配置 `free_zone_config`（app_core 运行时配置，走现有的草稿、发布、回滚流程）

```
enabled: boolean
rules_text: string（≤200 字；前端最多显示三行）
period: { starts_at, ends_at }                     # 福利期（第一版整周免费），必填
scope: 'all_cards' | 'own_cards'                   # 使用范围，未定，由运营设置
candidates: [{ id, surplus_model, display_name, tagline, family, benchmark_tier }]
screening:  { min_discount_pct: 85, min_offers, min_realized_discount_pct, min_uptime_pct,
              max_ttft_p50_ms, max_ttft_p90_ms, min_tps, min_samples, max_providers: 2 }
on_shelf:   { window_hours: 24, min_turns: 50, max_no_output_pct, max_fallback_delivered_pct,
              max_timeout_pct, max_ttft_p90_ms, max_refusal_pct, max_truncation_pct, max_dislike_pct }
relist:     { required_passes: 2, cooldown_official_min: 120, cooldown_business_min: [1440, 4320, 10080] }
first_token:{ primary_wait_ms: 4000, deadline_ms: 7500 }
```

- 门槛字段可以为空，空表示不检查。
- 只用 trusted 供应商是写死的，不做成配置。
- 检查频率固定 30 分钟，不做成配置。

### 2.2 运行状态（需要新表，归属 `miniapp_features`）

这两张表跟着本功能走：功能下线，表可以一起删；它们决定线上行为，所以不放在分析域。

- `miniapp_features.free_zone_models`：每个候选模型一行，记录当前的真实状态。
  - 字段：`status`（未上架 / 在架 / 冷却中）、`providers`（当前在用的那一家供应商）、`provider_since`（这家从何时开始用，业务指标从这里起算）、`excluded_providers`（业务越线被排除的供应商及到期时间）、`consecutive_passes`、`cooldown_until`、`delist_count_7d`、`last_reason`、`last_metrics`（最近一次评估快照，包含平均实际价格）、`updated_at`。
  - 只有评估任务写；线上读路径只读。
- `miniapp_features.free_zone_events`：只追加，记录每一次上架、下架、冷却到期，带原因和指标快照，用来复盘。
- 两张表都开 RLS，只给 service_role 用。数据量：每个候选一行，事件每天几十条。
- 不跨 schema 建外键：候选 id 来自运营配置，不是数据库外键。
- 业务指标只定义一份：建一个只读视图 `analytics_grafana.v_free_zone_model_metrics`，按「模型 × 供应商 × 小时」从 `experience` 的表里聚合，包含：没出字、兜底交付、超时、首字、拒答、截断、点踩、实际扣费、成功出字次数、平均输入长度。
  - 评估任务按窗口对这个视图再做一次汇总；
  - Grafana 面板直接读这个视图。
  - 这样两边口径一致。放在 `analytics_grafana`，沿用现有 Grafana 视图的约定。跨 schema 只读，授权写进迁移。
- Grafana：在现有的模型相关看板里加一组「畅聊」面板（具体放哪个看板，实施时先列出现有看板再定）。面板内容：平均实际价格、平均输入长度、业务指标趋势、模型状态和上下架记录。状态和记录读 `free_zone_models`、`free_zone_events`，给 Grafana 的只读账号授权查询。

## 3. 评估任务（`features/free-zone/evaluation-job.ts`）

- 每 30 分钟一次。多副本之间用 advisory lock 保证同时只跑一份；每次执行都记录。
- 第 1 步：读运营配置和状态表。总开关关着就只记录，不改任何状态。
- 第 2 步：拉 Surplus 公开数据。每个候选模型调两个接口：报价列表 `/api/markets/{model}`、分供应商表现 `/api/analytics/performance/{model}`。
  - 某个模型的数据拉失败：这个模型这一轮标记为「数据缺失」。
- 第 3 步：拉业务数据。只看在架模型；从数据库聚合统计窗口内的各项指标，同时算出平均实际价格和平均输入长度。
- 第 4 步：用纯函数算状态变化，可以单测：
  - **未上架**：初筛通过（且按选择规则挑得出一家），连续达标次数加 1；达到要求次数就上架并选定供应商。初筛没过，连续次数清零。
  - **在架**：
    - 官方复核越线：下架，冷却期按「官方原因」算；
    - 业务数据越线：下架，冷却期按「业务原因」的梯度算；
    - 数据缺失：保持在架，不动。
  - **冷却中**：到期后转回「未上架」。
- 第 5 步：用短事务写回状态表和事件表；状态变化打 biz 日志。

## 4. 线上读路径

- **栏目快照**：状态表加运营配置，在进程内缓存 30 秒；读失败时用上一次的快照。目录接口不额外查库。
- **`free_zone` 怎么算**：根据「用户 + 角色卡 + 当前时间」：
  - 返回 null（不显示）：总开关关了，或者已经过了福利期的结束时间。
  - 未开放：
    - 还没到福利期开始时间：原因 `not_started`，带开始时间；
    - 范围限自己的卡、当前是别人的卡：原因 `own_card_only`；
    - 一个在架模型都没有：原因 `no_models`。
  - 其他情况都是开放，带福利期的结束时间。
  - 「是不是自己的卡」复用 `getCharacterCreatorOwner`，目录接口里本来就在查。
  - 栏目里的模型 = 在架的候选模型；划线原价 = 对标档位当前的星尘价。
- **自动换模型**（目录接口和生成前都会检查）：如果用户当前选的是免费模型，但它不在架或栏目不开放，就按「同系列 → 随机 → 1017」换掉并写回用户的选择，只记日志，不给用户任何提示（用户定：在公告里统一说明）。
- **选择按用户存，不按角色卡**（用户已确认，现有逻辑本来就是这样，不改）：范围限自己的卡时，用户在自己的卡上选了免费模型，再去聊别人的卡，就会换回 1017；回到自己的卡要重新选。

## 5. 生成

- `resolve-model`：选中的是免费模型、并且这一刻开放时：
  - 供应商用 surplus，模型 id 用 `surplus_model`；
  - 主模型超时和首字总上限改用栏目配置的值；
  - 兜底模型不变（1017）。
- 发给 Surplus 的请求：头里带 `X-Min-Discount: {折扣底线}`，请求体带 `provider: [白名单]`。这些字段只对免费模型的请求生效。
- 开轮时冻结报价：扣费类别记为畅聊、应扣 0。扣费只看开轮那一刻，生成到一半栏目到点关闭也不受影响。
- 调用明细里记一个「这轮是畅聊」的标记，加上当时的白名单，用来按模型统计业务指标。

## 6. 公开契约

```ts
PublicFreeZone =
  | { open: true,  ends_at, rules, models }
  | { open: false, reason: 'not_started', starts_at, rules, models }
  | { open: false, reason: 'own_card_only' | 'no_models', rules, models }
PublicFreeZoneModel = { id, display_name, tagline, benchmark_tier, original_credits }
GetModelCatalogData += { free_zone?: PublicFreeZone | null }
```

## 7. 前端

和之前的定稿一致：

- 新建栏目组件 `chat-free-zone-section.tsx`，以及判断时间、选中状态的纯函数；
- 面板和顶栏接入，顶栏有角标，到了时间点重新拉目录；
- 未开放时，时间标签按原因显示：
  - `not_started`：「<时间> 开始」；
  - `own_card_only`：「仅限自创角色卡」；
  - `no_models`：「暂未开放」。
  - 只有 `not_started` 需要到点重新拉目录。

## 8. 可靠性

- **外部调用**：Surplus 公开接口 8s 超时，不重试，失败了等下一轮。连续失败会被执行记录捕获，可以配告警。
- **故障保护**：数据缺失时不下架；状态表读失败时用缓存快照；没有快照就当栏目关闭（返回 null），用户的选择在下次能读到状态时再处理。
- **并发**：任务靠 advisory lock 单例运行；状态写入是幂等的覆盖。自动换模型是同一个用户的覆盖写，和手动切换同时发生时以后写的为准，和现有 VIP 回落的行为一致。
- **成本**：每轮任务对每个候选调 2 次公开接口，20 个候选是 40 次 / 30 分钟。
- **不适用**：没有资金写入，扣 0 走现有冻结报价，不新增钱包写入。

## 9. 发布与回滚

1. 迁移：先在 TEST 执行，再上生产。
2. 后端：任务开始跑、填状态表，但总开关默认关，所以线上没有变化。
3. 前端。
4. 运营配置：填候选池和参数，发布时打开总开关。

回滚：关掉总开关，栏目立刻隐藏；正在用免费模型的用户下一次就换回 1017。不需要回滚代码。

## 10. 验证

- 纯函数单测（用户已同意）：初筛、在架判断、冷却梯度、自动换模型顺序、栏目状态（福利期、使用范围、没有在架模型）、扣 0 的报价。
- 迁移的 SQL 场景测试，沿用现有的本地 PG 流程。
- ui-tests 加场景：开放、福利期未开始、仅限自创、模型下架后已替换。新增 `@free-zone` 自动验收组（用户已同意），覆盖：开放时能选、未开放时折叠且点击不发请求、关闭时完全隐藏、替换后不弹提示。
- Grafana：面板的查询结果和评估任务快照里的数字对得上。
- TEST 环境：用真实 Surplus 跑一次任务，核对状态表；用测试账号在自己的卡上发消息，核对请求头、请求体、扣 0、调用明细。

## 11. 实现与上文的差异（2026-11-11 第一版）

- 指标视图放在 `miniapp_analytics`（不是 `analytics_grafana`）：schema 规范把只读分析投影归到这里；Grafana 通过现有的 `first_token_metrics_reader` 角色读取，不需要开基表权限。
- 评估任务**不看总开关**：只要配置里有候选就评估。这样可以先关着栏目，在 Grafana 里看哪些模型达标，再打开。总开关只决定用户能不能看到栏目。
- 供应商（用户 2026-11-11 定）：先列出全部达标供应商；价格差不到 `price_band_ratio`（默认 3）倍的算一档，挑首字 p50 最低的；更贵的档只在便宜档没人时才用。选定后一直用，不达标或业务越线才按同一规则顺延；业务越线的那家排除 `cooldown_business_minutes[0]`（默认 24 小时）；全部不行才下架。白名单只放当前那一家，业务指标从 `provider_since` 起算。去掉了 `max_providers`。
- 自动换模型不给用户任何提示（目录接口和生成链路都只写日志），公开契约里不再有 `selection_notice`。
- 评估任务拉 Surplus 行情时一次最多同时问 4 个模型，避免候选多时被公开接口限流。
- 前端在流开始前的首字计时仍按付费目录的上限算（5 秒）。流开始后，服务端会下发免费模型自己的 7.5 秒上限，以后者为准。
- 「回到默认模型」用的是付费目录的 `default_model_id`，生产上目前就是 1017。
