# Design：畅聊按身份开放

## 1. 总体

在现有畅聊（`features/free-zone`）的"栏目视图 → 选择结算 → 生成"链路上加一层**按用户的开放判定**，不新建表、不改库：

```
free_zone_config.access（运营参数）
        +  用户事实：users.created_at、vip_memberships.valid_until、vip_purchase_grants 最近 granted_at
        ↓  evaluateFreeZoneAccess（纯函数，北京时间）
   开放：via = welfare | trial | vip_welcome | vip_weekly，ends_at
   关闭：audience = vip | non_vip，下一次周四窗口，最近一次"结束"(trial/welfare) 及时间
        ↓
 viewFreeZone(snapshot, {access,...}) → PublicFreeZone（新增 access 字段 + vip_waiting / vip_only 两种状态）
        ↓                                           ↓
 目录接口（栏目卡五种身份）               生成链路 settleFreeZoneSelection（不可用→默认付费模型，现有行为）
        ↓
 GET /api/growth/prompts：VIP 弹窗 context（trial_ended / welfare_ended / vip_day）+ 频次
```

`access.enabled=false` 时 `evaluateFreeZoneAccess` 只看福利期，输出与现在 `viewFreeZone` 完全一致——这是开关与回滚的基础。

## 2. 复用调研

| 检索对象                                                                                                   | 结论                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `free-zone/zone-view.ts` `viewFreeZone` / `chooseReplacement`                                              | **扩展**：入参加 `access`，按开放结果出状态；替换规则不动                                                                                              |
| `free-zone/selection.ts` `resolveFreeZoneSelection` / `settleFreeZoneSelection` / `resolveCatalogFreeZone` | **扩展**：透传用户事实；"不可用→默认付费模型并写回选择"保持现状（满足"不拦截直接切"）                                                                  |
| `generation/resolve-model.ts` `resolveModelForUser`                                                        | **扩展**：已有 `vipStatus().getStatus`（valid_until）；补读 created_at、最近开通时间                                                                   |
| `routes/models.ts` 目录接口                                                                                | **扩展**：`getOrCreateDbUser` 已带 `created_at`；补读最近开通时间                                                                                      |
| `billing.vip_purchase_grants` + 索引 `(user_id, granted_at DESC)`                                          | **复用**：开通礼起点。不新增列                                                                                                                         |
| `app_core.users.created_at`                                                                                | **复用**：试用起点（重组 3a 保留列）                                                                                                                   |
| `growth/prompt-rules.ts` `canShowAgain` / `promptCap`                                                      | **改写 VIP 部分**：50 轮触发、"付费只弹 1 次"去掉，换成 3 天间隔 + 每 3 次停 30 天                                                                     |
| `GrowthPromptRepository.recordEvent` → `record_growth_prompt_event`                                        | **复用不改**：传 `p_max_shows = 当前次数 + 1` 做原子比较即可实现"每 3 次停 30 天"，多设备同时弹只会成功一次；与 DB 重组 3b-1（签名、原子语义不变）兼容 |
| 前端 `GrowthPromptHost` / `pickGrowthPrompt`（`at_rounds`）/ `isCalmMoment` / `claimPromptSlot`            | **复用**：ended 场景 `at_rounds = total_rounds + 1`（完成切换后的第一轮才弹），周四 `at_rounds = 0`                                                    |
| `GrowthPromptCard`                                                                                         | **扩展**：VIP 分支换成并排双券；进群分支不动                                                                                                           |
| `lib/free-zone.ts` `freeZoneBoundaryDelay` / `freeZoneStatusText` / `freeZoneClosedHint`                   | **扩展**：新状态的文字与刷新时间点；边界刷新时顺带失效弹窗资格查询                                                                                     |
| `ChatFreeZoneSection`                                                                                      | **扩展**：VIP 标签、非会员开通按钮、文案按 access 参数生成                                                                                             |
| `useSelectModelMutation`（`/api/v1/models/select`）                                                        | **复用**：开通成功后自动选回畅聊模型                                                                                                                   |
| 运营平台 `FreeZoneConfigEditor` / `freeZoneForm`                                                           | **扩展**：新增"按身份开放"一节；配置 schema 直接用 shared 的 `FreeZoneConfigSchema`，字段不会被剥掉                                                    |
| 不复用：`billing.feature_free_trials`                                                                      | 那是按功能次数的试用，语义不同                                                                                                                         |

## 3. 关键设计

### 3.1 配置（shared `FreeZoneConfigSchema.access`）

```ts
access: {
  enabled: false,                    // 关=只有福利期，和现在一致
  trial_since: null | ISO,           // 这之后注册的才有新人试用；null=不开试用
  trial_hours: 72,
  vip_welcome_days: 5,               // 0=不送开通礼
  vip_weekly: { weekday: 4, start_minute: 720, duration_minutes: 900 },
  prompt: { min_interval_days: 3, batch_size: 3, batch_cooldown_days: 30 }
}
```

时区固定 Asia/Shanghai（UTC+8，无夏令时），用 +8h 偏移计算，不引入时区库。

### 3.2 开放判定 `free-zone/access.ts`（纯函数）

输入：`config`、`now`、`facts { createdAt, vipValidUntil, lastVipGrantAt }`。

1. 福利期内 → open(welfare, period.ends_at)。
2. `!access.enabled` → 关闭且栏目不显示（返回 null，等同现状）。
3. 收集开放窗口：trial（`createdAt >= trial_since` 且 `now < createdAt + trial_hours`）；会员有效时 welcome（`lastVipGrantAt + days`，截到 valid_until）与 weekly（当前周的窗口，截到 valid_until）。
4. 有窗口 → open，`via` 取结束最晚的那个，`ends_at` 取最晚结束时间。
5. 无窗口：会员且下一个周四窗口早于到期 → `vip_waiting(starts_at)`；否则 → `vip_only`，带当前/下一个周四窗口（给弹窗和前端刷新用）。
6. 另算 `ended`：试用结束或福利期结束在 7 天内的最近一个（`trial` / `welfare` + 时间），只给弹窗用。

### 3.3 公开契约（shared `PublicFreeZone`）

- 所有状态加 `access`：`{ via, audience: 'everyone'|'trial'|'vip'|'non_vip', trial_hours, vip_welcome_days, vip_weekly }`，前端据此拼文案（"新人专享 3 天…""每周四 12:00 至次日 03:00"）。
- 新状态：`vip_waiting { starts_at }`、`vip_only { vip_day: { open, starts_at, ends_at } }`。
- `access.enabled=false` 时后端不会产出新状态。上线顺序：前后端一起发、开关保持关 → 确认部署完成后再开，旧缓存前端基本已刷新；前端对未知状态按"未开放"兜底。

### 3.4 生成与切换

- 生成预检：只有在选中免费模型且 `access.enabled` 时才读用户事实（created_at、最近开通，各一条主键/索引读，与现有读并行）。
- 不可用 → 沿用现有替换：默认付费模型（DeepSeek V4.1 Flash 1017，轻量 15 星尘），写回选择，照常计费。不改计费链路。
- 分隔线**前端推导**：`ChatMessage` 新增可选 `credits_per_turn`（映射已有的 `chat_history.deduction_rate`，展示视图本来就选了这一列，不改库）；上一轮回复为 0、这一轮 >0 → 在这一轮第一条消息前插分隔线。`model_id` 存的是上游模型名（如 gemini-3.8-flash），分不出免费/付费，所以不用它。文案：最近一次切换且栏目当前对用户关闭时带原因（会员"本次畅聊已结束…下次畅聊：周四 12:00"，非会员"畅聊已结束…"）；其余为中性"以下改用{档位}模型 · 每轮 {n} 星尘"。
  - 拒绝的方案：把切换原因落到 `chat_history`（展示走 SQL 投影视图，要改热路径视图与迁移）或 SSE start 事件（目录接口可能先一步替换掉选择，生成侧就看不到切换，原因不可靠）。

### 3.5 VIP 弹窗

- 资格（服务端，GET /api/growth/prompts）：可购买、非会员、`access.enabled`、不在试用期；
  - `ended` 存在且 `last_shown_at` 为空或早于结束时间 → `context = trial_ended | welfare_ended`，`at_rounds = total_rounds + 1`；
  - 否则周四窗口开放中 → `context = vip_day`，`at_rounds = 0`；
  - 否则不返回。
- 频次：`shown_count` 为 3 的倍数（>0）时距上次需满 `batch_cooldown_days`，否则需满 `min_interval_days`；`p_max_shows = shown_count + 1`。GET 预判、POST shown 时由函数原子判定（返回 false 前端不弹）。
- 复用 prompt key `vip`：沿用 11-13 起的展示记录，旧 50 轮弹窗的展示也计入"30 天 3 次"，符合"短期内别弹太多"；历史不丢。
- 载荷在原字段基础上加 `context`、`bonus_main_credits`、`welcome_days`、`vip_day`；旧字段保留，旧缓存前端仍能显示旧卡。
- 前端：边界刷新目录时一并失效弹窗资格查询，所以试用到点、周四 12:00 不必重开小程序。

### 3.6 开通后自动选回

订单页看到 VIP 订单 `completed` → 失效目录 → 目录里畅聊开放且有模型 → `useSelectModelMutation` 选第一个在架模型（选择失败只记日志，不影响到账展示）。

## 4. 可靠性

| 故障                        | 处理                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 读用户事实失败（超时/报错） | 生成侧：**放行**——按"福利/会员窗口外也算开放"处理本轮（每轮成本约 ¥0.017，远小于误扣会员钱的伤害），warn `free_zone.access_facts_failed`；目录侧：同样放行显示。读走现有 supabase 客户端超时 |
| 配置非法                    | shared schema 校验失败走现有 snapshot 降级（栏目不显示）                                                                                                                                     |
| 多设备同时弹                | `record_growth_prompt_event` 条件 upsert，`p_max_shows = 次数+1` 做比较交换，只有一个成功                                                                                                    |
| 时间边界                    | 后端按服务器时间判定；前端本地时钟只做"已过结束时间当未开放"兜底（现有逻辑）                                                                                                                 |
| 自动选回失败                | 不重试，下次用户手动选；记日志                                                                                                                                                               |
| 并发/幂等/补偿/限流/容量    | 只读判定，无新写入；新增读都是主键/索引单行；不适用补偿与限流                                                                                                                                |

日志：复用 `models.config.free_zone_replaced`（reason 加 `via`/`audience` 摘要）、`free_zone.selection_replaced`、`growth.prompts.read`（加 `vip_context`）、`growth.prompt.event`；新增 warn `free_zone.access_facts_failed`。不记录用户资料原文。

## 5. 最小充分

- 不建表、不改库、不加数据库函数；不加时区库；不做通用"权益系统"。
- 拒绝：试用按第一条消息算（要新表+写路径，数据上几乎无差别）；新 prompt key（要改 CHECK，和重组冲突）；切换原因落库。

## 6. 演进与恢复

- 发布：一个 PR（shared + backend + admin + frontend）→ dev → TEST 打开 access 验收 → 发布分支（最新 main + 本改动）→ 生产部署（开关关，零行为变化）→ 运营 CLI 打开开关：`access.enabled=true`、`trial_since=2026-11-22T00:00:00+08:00`、其余默认；同时改月卡说明文案。**必须在 11-22 00:00 福利期结束前完成**。
- 停止条件：生成报错率、402 比例异常上升，或弹窗投诉 → 关 `access.enabled`（即时、无需发版）。
- 回滚：关开关即回到"福利期外不显示"；代码问题 forward-fix。无数据迁移，无旧数据处理。
- DB 重组 3b-1：本改动不碰表结构；依赖 `record_growth_prompt_event` 签名与原子语义，已告知用户转达重组窗口。

## 7. 可验证性

见 implement.md：单测覆盖开放判定（时区、边界、重叠、到期、开关关）、弹窗资格与频次、分隔线位置；运营表单单测；全量 typecheck / test / lint / build；TEST 环境人工场景（新用户、会员、非会员、周四时间段用改参数模拟）。
