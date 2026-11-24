# 设计：状态栏与记忆栏质量漏斗

## 1. 现状（main e6ac6b01）

| 环节     | 状态栏                                                                                              | 记忆栏                                                                              |
| -------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 模型调用 | `generation/status-bar-model.ts` `callStatusModel`，首发 + 兜底，两功能共用                         | 同左                                                                                |
| 输出处理 | `shared/status-bar/validate.ts` `validateStatusOutput`：解析、按模板对账、缺项沿用                  | `shared/memory-bar/apply.ts` `applyMemoryBarOutput`：JSON 解析、长度/任务检查、合并 |
| 落库     | `record_chat_status` RPC                                                                            | `MemoryBarRepository.record`（比对上一条，冲突放弃）                                |
| 显示     | 前端 `StatusView` 用 shared `parseStatusBody` 解析规范文本，**按值的写法**选组件                    | 前端按结构化 state 字段直接渲染                                                     |
| 日志     | pino `status_bar.update`（只记最终采用的尝试）、`status_bar.primary.failed`（错误码被 safe-log 吞） | pino `memory_bar.update`、`memory_bar.primary.failed`（同样吞码）                   |
| Grafana  | 无                                                                                                  | 无                                                                                  |

关键事实：

- pino 业务日志只进 Railway，**不进 Grafana**。进 Grafana 的是 `lib/engineering-observability.ts` 的工程遥测：counter/histogram → Cloud Metrics（Prometheus），`event` → Cloud Loki。生产已在用（如 `st_chat_requests`）。
- 状态栏前端显示是规范文本的纯函数，且与后端共用解析器 → **最终显示结果可以在后端写库时直接算出**，不需要前端上报。
- 记忆栏存的是通过 zod 的结构化 state，前端按字段渲染，不存在"按写法猜组件"，因此记忆栏漏斗止于落库。

## 2. 漏斗定义

### 2.1 尝试层（每次调模型一条，首发/兜底分开）

`stage` 表示这次尝试停在哪一层：

| stage     | 状态栏                                                                        | 记忆栏                                     |
| --------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| `model`   | `StatusModelError`（首字超时、截断/被拦、HTTP、超时…），`error_code` 记具体码 | 同左                                       |
| `format`  | 输出是旧格式（`<details>`），或一个"名称：内容"行都没有                       | 没有合法 JSON（`OutputSchema` 不过）       |
| `content` | 解析出来了但对账没全过（缺项、写法不对、没换真名、超组数、多余行）            | 长度/压短/前情概要检查不过，或合并后超上限 |
| `ok`      | 对账全过                                                                      | 检查通过                                   |

`problem` 标签给出 `content` 层的主因（有界枚举）：状态栏 `missing / bad_format / placeholder / extra_groups / stray_lines`；记忆栏 `record_too_long / compress_missing / compress_too_long / summary_missing / summary_too_long / over_limit`。

### 2.2 更新层（每次更新一条）

- 状态栏 `result`：`perfect`（落库且每一项都是本次写对、显示组件符合样式）/ `degraded`（落库但有沿用或显示错位）/ `failed`（没落库）。
- 状态栏 `stage` = 这次更新"掉在哪"，每次更新只归一个原因，按优先级取第一个命中：`model`（两次尝试都没拿到完整输出）> `format`（拿到了但认不出状态栏）> `store`（写库抛错）> `content`（落库但有项沿用）> `display`（都是新值但有项显示错位）> `ok`（perfect）。前三个对应 `failed`，`content`/`display` 对应 `degraded`。这样 `1 - 完美率` 恰好拆成五块之和，整体下降时能直接看出是哪一层变大。
- 记忆栏 `result`：`recorded` / `no_progress`（模型判断没进展，按设计是正常结果）/ `conflict`（并发写被放弃）/ `failed`（带 `stage`）。
- `STATUS_DISABLED`、没有轮次等 skipped 不计入。

### 2.3 项级（只有状态栏，按样式）

每次更新对每个模板项（含每人一组的每组）记一个结果，计数到 `style × result`：

| result          | 含义                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `fresh`         | 本次模型写对，且显示组件符合样式                                                                                |
| `empty`         | 本次写的是"暂无"（提示词允许的合法值）                                                                          |
| `kind_mismatch` | 本次写法通过校验，但前端会显示成别的组件（如"一句话"项写成 `3/5` 被画成进度条；数字项写成 `26` 显示为普通文字） |
| `carried`       | 缺失或写错，沿用上次的值（或补成"暂无"）；更新失败时该次全部项都算 `carried`                                    |

"显示组件符合样式"的规则放在 `shared/status-bar/spec.ts` 每种样式旁（新增 `renders`），和提示词、校验同源：

| 样式                                   | 期望的显示                                                 |
| -------------------------------------- | ---------------------------------------------------------- |
| bar / percent / stars / stage / number | 同名组件                                                   |
| tags                                   | 标签胶囊；单个短词（≤10 字、无句读）显示为普通文字也算符合 |
| line / para                            | 普通文字（被识别成进度条、阶段、标签、数字算错位）         |
| checks / bullets                       | 清单（校验已保证）                                         |

### 2.4 口径（用户 2026-11-24 拍板）

- 状态栏**整体成功率** = `perfect` ÷ 全部计入的更新。沿用算失败。
- 状态栏**项级成功率** = `fresh` ÷ 全部项；**沿用率** = `carried` ÷ 全部项，单列对照。
- "暂无"不算失败、不破坏 `perfect`（提示词明确要求没信息写暂无，开局阶段大量合法出现），单列"暂无率"（用户 2026-11-24 确认）。
- 记忆栏**整体成功率** = (`recorded` + `no_progress`) ÷ 全部计入的检查；记忆栏没有"部分对"，是严格的 模型 → 格式 → 内容 → 落库 漏斗。
- 两套视图分开看：
  - **首发漏斗**（尝试层，channel=primary）：完整返回 → 格式认得出 → 对账全过，用于优化首发模型与提示词；
  - **最终结果分解**（更新层 stage 堆叠 100%）：兜底之后玩家实际看到的结果，即整体成功率的拆解。
- 严格的"一层扣一层"只在单次尝试内部成立；跨首发/兜底、跨"整次失败/逐项降级"用 stage 优先级归因。

## 3. 方案

### 3.1 指标（Cloud Metrics，低基数）

| 指标                | 标签                                                                                 | 值   |
| ------------------- | ------------------------------------------------------------------------------------ | ---- |
| `st_panel_attempts` | panel(status/memory)、channel(primary/fallback)、trigger、stage、problem、error_code | 1    |
| `st_panel_updates`  | panel、trigger、result、stage、channel（最终采用）                                   | 1    |
| `st_status_items`   | style（10 种）、result（4 种）、trigger                                              | 项数 |

基数上限：attempts ≈ 2×2×2×4×(12+1)×(≤16 码) 远低于千级；`error_code`/`problem`/`model` 用 `boundedLabel` 封顶。**不带** sessionId、userId、模型输出等任何内容。

### 3.2 代码改动

1. `lib/engineering-telemetry-exporter.ts`：`count(name, attrs, value = 1)`，向后兼容。
2. `lib/engineering-observability.ts`：新增 `observePanelAttempt / observePanelUpdate / observeStatusItems`，只做标签收口（约 40 行，文件 406→约 450，低于 500 行上限）。
3. `shared/status-bar/spec.ts`：每种样式加 `renders(item, value)`。
4. `shared/status-bar/validate.ts`：`StatusValidation` 增加 `items: { style, result }[]`（逐项结果，含显示检查）和 `stage`（format/content/ok）；现有 `problems` 不变。
5. `shared/memory-bar/apply.ts`：失败结果增加 `stage`（format/content）与 `problems` 码数组；`issues` 文案不变。
6. `backend/features/status-bar/update.ts`、`features/memory-bar/update.ts`：每次尝试后调 `observePanelAttempt`；终态调 `observePanelUpdate`（状态栏再调 `observeStatusItems`）；写库包一层 try/catch 只为记 `stage=store` 后原样抛出；pino `*.update` 增加 `freshCount / emptyCount / kindMismatchCount / carriedCount`；`*.primary.failed` 增加 `error_code`。
7. `docs/grafana/st-panel-quality.json` + `docs/grafana/README.md` 登记一行。

不改：接口契约、数据库、前端、提示词、重试逻辑、落库内容。

### 3.3 看板 `st-panel-quality`

- 第一排：状态栏整体成功率、项级成功率、沿用率、暂无率；记忆栏整体成功率（按天，`increase(...[1d])`）。
- 第二排：各层成功率漏斗（模型 → 格式 → 对账 → 落库 → 显示），首发/兜底分开。
- 第三排：首发失败 `error_code` 分布；`content` 层 `problem` 分布；状态栏按样式的 `carried / kind_mismatch` 率。
- 变量：environment（默认 production）、trigger。
- 样本量面板与比率并排，少于 100 标低样本。

## 4. 复用调研

| 检索对象                                                                 | 结论                                                                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `lib/engineering-observability.ts` / `engineering-telemetry-exporter.ts` | 复用：生产已开启的 OTLP 通道与 `boundedLabel`；只给 `count` 加可选值参数                                                     |
| `platform/observability/safe-log.ts`                                     | 复用：`error_code`、`*Count` 已在白名单，不改白名单                                                                          |
| `StatusValidation.problems`（11-20 新增）                                | 复用作 `problem` 标签来源；补逐项结果                                                                                        |
| `memory-bar/apply.ts` `issues`                                           | 不复用文案做分类（中文短句不稳定），新增稳定码                                                                               |
| `ops.llm_calls`                                                          | 不复用：状态/记忆模型调用当前不写该表；本任务只要比率，不需要 SQL 聚合，不新建表（CONTRACT §4：只为排障/监控的走日志与指标） |
| 告警 `alert-rules.json`                                                  | 不接：用户确认不做告警                                                                                                       |
| 前端 `StatusView`                                                        | 不改：显示结果由后端用同一解析器算出                                                                                         |

## 5. 可靠性

- 遥测调用全部同步、无 IO，`guarded` 吞掉异常；遥测关闭时直接返回。不改变任何业务结果。
- 写库 try/catch 只记录后 `throw` 原错误，`maybeAutoUpdateStatus` / 手动刷新的错误处理不变。
- 不新增重试、超时、并发、事务；进程内 inFlight 复用时，等待者不重复计数（只在 `doUpdate` / `doCheck` 内部计）。
- 指标是进程内累计、15 秒导出；重启丢失未导出的部分，影响很小，看板按天看比率。

## 6. 发布与回滚

- 纯增量：先合 main，生产自动部署；看板 JSON 通过 Grafana API 导入。
- 回滚：revert 本 PR 即可，无数据迁移。看板保留不影响任何服务。
- 停止条件：发布后 `st_telemetry_failures` 明显上升，或任何 `status_bar.update` / `memory_bar.update` 的 outcome 分布与发布前显著不同（说明误改了业务逻辑）→ 回滚。

## 7. 基线（2026-11-24 补算，生产只读）

新指标发布前没有 Grafana 历史，以下是用两份既有数据补算的近似基线，发布后以看板为准。

### 7.1 对账层与通道（Railway `status_bar.update`，11-20 16:00 ~ 11-24 19:40，45 个部署，7846 次更新）

| 日期  | 更新数 | 全对  | 降级  | 失败 | 项命中率 | 首发一次全对 | 走了兜底 |
| ----- | ------ | ----- | ----- | ---- | -------- | ------------ | -------- |
| 11-20 | 597    | 71.7% | 28.3% | 0.0% | 99.3%    | 17.6%        | 82.4%    |
| 11-21 | 1681   | 90.2% | 9.7%  | 0.1% | 99.5%    | 36.1%        | 63.9%    |
| 11-22 | 1767   | 90.9% | 9.1%  | 0.0% | 99.3%    | 26.3%        | 73.7%    |
| 11-23 | 2395   | 94.7% | 5.2%  | 0.1% | 99.7%    | 55.4%        | 44.6%    |
| 11-24 | 1406   | 92.7% | 6.9%  | 0.4% | 99.6%    | 53.9%        | 46.1%    |
| 合计  | 7846   | 90.8% | 9.1%  | 0.1% | 99.5%    | 41.6%        | 58.4%    |

- "全对"= 校验 ok（无沿用、无多余行），还没扣显示错位；降级里各问题出现占比：写法不对 36.1%、没换真名 18.6%、缺项 13.2%、超组数 11.8%、多余行 5.0%。
- 兜底救回很多：最终失败只有 0.1%，但首发一次全对只有约 54%（11-23 起），超过四成更新要靠兜底。

### 7.2 显示层（生产 `chat_status_snapshots` 近 4 天 6651 条，按当前生效模板跑显示检查；51 条模板已不可用跳过）

- 项合计 73841：写对 98.2%、显示错位 1.6%、暂无 0.1%、与模板对不上 0.1%（模板事后被改过，非模型问题）。
- 有显示错位的记录占比：11-20 37.1% → 11-21 15.4% → 11-22 22.8% → 11-23 11.7% → 11-24 10.9%。
- 错位集中在两种样式：**标签 14.4%**、**数字 6.5%**；一句话 0.6%；其余样式为 0。
  - 标签：最多的是末尾带句号（`A、B、C、D。`），整串被当成普通文字，胶囊显示不出来；其次是单个标签超过 10 字。
  - 数字：一两位、不带单位（如 `26`）显示为普通文字而不是大号数字（校验特意放行，显示仍不同）。
  - 一句话：写成 `A、B、C` 被画成标签胶囊。

### 7.3 合成的整体成功率估计

完美 ≈ 全对 × (1 − 有显示错位的记录占比) ≈ 11-23/24 约 **82%~84%**（两份数据口径不同，仅作发布后对照的量级参考）。

### 7.4 记忆栏

记忆栏 11-23 才上线，pino 日志没有按层的字段，没有可补算的基线，以发布后看板为准。
