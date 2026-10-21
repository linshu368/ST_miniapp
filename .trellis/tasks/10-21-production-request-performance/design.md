# 设计：Sentry 驱动的优化方案（待审核，未实施）

状态：待审核；**不授权产品代码变更**。证据：主文档 E18（2026-10-21 Sentry 7d）+ 本轮源码回读。

权威分析总表仍在 `docs/production-request-performance-plan.md`。本文给出各批次**可实施的优化设计**：改什么、不改什么、验收与回滚。

---

## 0. 设计总则

| 原则 | 含义 |
| ---- | ---- |
| 证据分层 | `SENTRY` 交易级 p95 ≠ 分段根因；长尾先有界等待，再改查询形状 |
| LLM 分轨 | messages/regenerate 总时长不得冒充代码收益；只验收 prepare / HTTP / 前端请求次数 |
| 最小充分 | 优先现有模块内改法；不建 Redis/队列/全局超时框架/新 ORM |
| 契约谨慎 | 默认不改 shared 公开 API；确需内嵌摘要时先审 shared 再动前后端 |
| 分层超时 | Prisma 池超时 ≠ PostgREST/supabase-js 超时 ≠ undici 300s 默认 |
| 一次一维 | 连接/超时参数每次只改一个维度；保存旧值于安全运维系统 |

拒绝的过度设计：按 ids 批量角色通用框架（除非前端 miss 证明必要）、金框物化列、跨请求缓存 chat history、用缩短模型输出换 p95。

---

## 1. 复用调研（本轮源码回读）

| 对象 | 路径锚点 | 决策 | 理由 |
| ---- | -------- | ---- | ---- |
| `/chats` 历史行 | `packages/frontend/src/app/(main)/chats/page.tsx` L113–120 `useCharacterQuery` | **P1-L-N1 首选：停掉逐行详情** | 注释已写明「只为头像」；收藏 Tab 已批量 |
| 大厅 list 缓存 | `lib/api/characters.ts` localStorage + `useCharactersQuery` | 作头像/名称来源 | 已有 `CharacterSummary`；勿用 Summary 硬灌 Detail cache |
| 会话列表契约 | `shared` `ChatSession` 仅 `character_id` | 二期可选内嵌摘要 | 模式对齐 favorites；非首批必需 |
| 详情金框 | `routes/characters.ts` L165–176：`findFirst` + **全量 `findMany` id** + ranking + pinned | **P1-N-DETAIL：抽 featured 快照，删全量扫描** | 金框须与大厅同源（源码注释）；可用 60s 缓存替代每请求全表 |
| 收藏金框 | `routes/favorites.ts` 全量 `findMany` 摘要 | 同 featured 快照 + `id in (...)` | 收藏少时也不应扫全大厅 |
| ranking/pinned | `features/lobby/*` 已有 60s TTL | 扩展为 featuredIds 同 TTL + single-flight | 复用既有模式 |
| 上下文两次 GET | `ConversationHistoryRepository.getContextBeforeTurn` L514–553 | **P1-S-HTTP：合并 OR 查询** | `windowStart>1` 时并行第二次 GET → ST-MINIAPP-2G |
| supabase client | `lib/supabase.ts` 未设 `db.timeout` | **P1-C：全局有界 + 热路径 signal** | 无 abort 可读到 undici ≈300s |
| `getOrCreateDbUser` / `fetchRuntimeConfigEntries` | `lib/user.ts` / `runtime-config.ts` | 补 abort；准备期 deadline 须传到底层 | race 只拒等待不取消 HTTP |
| generation / settle | `features/generation/*` | 不改计费/CAS 顺序 | 非本轮提速对象 |

---

## 2. 批次优化设计

### 2.1 P0-A — 基线固化与分段观测（设计）

**目标**：把 E18 变成可复跑对照，并补「同请求阶段」缺口。

| 项 | 设计 |
| -- | ---- |
| Sentry 对照表 | 固定查询：http.server p95 by transaction、pageload p95、Supabase REST >5s count、Issues 1Y/3M/2G |
| 后端阶段日志 | 复用 pino：characters 列表/详情记 `phase=list|detail|featured|ranking` + duration；messages 记 `prepare_ms` / `context_http_count` / `dispatch_ms`（无正文） |
| 前端 | 可选：大厅/chats 记脱敏请求次数（不落 initData） |
| 不做 | 新 APM 产品、逐 token 日志 |

**验收**：改前后同一 `statsPeriod` 可并排；无秘密字段。

---

### 2.2 P0-B — 大厅有界等待（设计）

**目标**：消除用户侧「skeleton 挂死」；**不**把超时当成功提速。

| 层 | 设计 |
| -- | ---- |
| 浏览器 | `useCharactersQuery` 的 fetch 尊重 Query `signal`；总预算候选 **15s**（含 1 次安全读重试），审核后落地 |
| Next 代理 | `/api/lobby-characters` 对上游设更短 deadline，body 读取受限 |
| UI | 失败可重试；有旧快照时保留卡片并提示刷新失败 |
| 不做 | 把 abort 当服务器 SQL 已撤销 |

**与 Sentry**：`GET /api/characters` p50≈100ms、p95≈60s → 有界等待优先保护尾部体验。

---

### 2.3 P0-C / P1-C — 连接与 PostgREST 超时（设计）

**容量表（交付物，先于调参）** 每服务一行：副本×进程、Prisma 池上限、pool_timeout、connect_timeout、supabase-js/`db.timeout`、常见查询 abort、滚动重叠系数。只存数值类别，不存 URL/秘密。

| 改动 | 设计 | 风险控制 |
| ---- | ---- | -------- |
| C-T1 | `createClient` 增加有界 `db.timeout`（候选与业务读 5–15s 对齐，审核定值） | 一次只改超时；观察 5xx/业务失败率 |
| C-T2 | `getOrCreateDbUser`、`fetchRuntimeConfigEntries`、未带 signal 的热路径补 `AbortSignal` | 与 `withConversationPreparationDeadline` 串联真实取消 |
| C-T3 | Prisma URL/启动配置显式 `pool_timeout`/`connect_timeout`（有容量数据后） | 禁止无限等待；提高 timeout 不是优化 |
| C-T4 | E10 排序 job：错峰/有界执行；E11 unlock 失败仍 close | TEST 故障注入 |
| 不做 | 每请求新建 client；默认扩副本；关闭结算恢复 |

**验收指标**：`supabase_rest_gt5s_count`（users / runtime_config / current_chat_history）下降；P2024/P2037 与 unaffected API 成功率同窗报告。

---

### 2.4 P1-L-N1 — `/chats` N+1 API（ST-MINIAPP-1Y）（设计）

**根因（CODE + SENTRY）**：`ConversationHistoryRow` 对每会话调用 `useCharacterQuery(character_id)` → 每唯一角色一次 `GET /api/characters/:id`（默认列表 ≤20）。仅需头像与缺省标题。

```text
现状: conversations list → N × GET /api/characters/:id
目标: conversations list → 0～少数 miss 次详情（或 0，若二期内嵌摘要）
```

#### 方案 A（首批，零契约）— 推荐

1. 从 `useCharactersQuery` / lobby localStorage 摘要按 `character_id` 解析 `avatar_url`、`name`。
2. 标题继续 `resolveSessionTitle(session.title, nameFallback)`。
3. **仅 miss**（下架/未进大厅缓存）时才启用 `useCharacterQuery`，或显示占位头像 + `session.title`。
4. **禁止**把 `CharacterSummary` `setQueryData` 进 `characterKeys.detail`（缺 greeting 等，污染聊天页）。

#### 方案 B（二期，小契约）

在 `ChatSession`（或 list DTO）增加可选 `character: Pick<CharacterSummary,'id'|'name'|'avatar_url'>`，后端 list 一次 join/批量取摘要。对齐 favorites 模式。须 shared 审核。

#### 明确不做

- 新建通用 `characters?ids=` 框架（除非 A 后 miss 率高且不愿动会话契约）。
- 仅靠加大 `staleTime`（冷启动仍 N 次）。

**验收**：ST-MINIAPP-1Y 事件/用户下降；`/chats` 打开时 Network 中 `GET /api/characters/:id` ≈ unique(miss)；列表展示正确；可独立回滚前端。

**依赖**：可与 P1-N-DETAIL 并行；A 不依赖后端。

---

### 2.5 P1-L-TAIL / P1-N-DETAIL — characters 长尾与「N+1 Query」（设计）

**根因修正**：ST-MINIAPP-3M 的 offending `BEGIN` 对应详情 handler **并行多路 Prisma**（含全量 id `findMany`），池紧张时多路 ≈60s 等待；**不是**经典 ORM 按行循环 N+1。

#### 共享组件：`loadLobbyFeaturedIdSet`（新，落在 `features/lobby/`）

| 项 | 设计 |
| -- | ---- |
| 输入 | 复用 `loadCharacterRankingScores` + `resolveLobbyPinnedCharacters` + **一次**运营序 id 列表 |
| 输出 | `Set<string>`（或只读快照） |
| 缓存 | 与 ranking 对齐：**60s TTL + single-flight**；失败可沿用旧快照（与现有 ranking 降级一致） |
| 语义 | 必须继续调用 `resolveLobbyFeaturedIds`，保证列表/详情/收藏金框同源 |

#### P1-N-DETAIL（`GET /api/characters/:id`）

1. `findFirst` **改为 `select` 契约字段**（id/name/description/avatar_url/tags/creator/first_mes/creator_notes…），避免拖 `raw_card` 等大 JSON。
2. 删除每请求全量 `findMany({ select: { id } })`；改为 `featuredIds.has(id)` 来自共享快照。
3. ranking/pinned 已在快照路径内；热缓存后详情常降为 **1 路 Prisma**。

#### P1-L-TAIL（列表 / badge / favorites）

| 接口 | 设计 |
| ---- | ---- |
| `GET /api/characters` | 保持摘要 `select`；recommended 的 ranking 刷新 **single-flight**（主文档 P1-B）；不默认分页 |
| `GET /api/favorites` | RPC 得 ids 后 `findMany({ where: { id: { in: ids }, …}})`；金框用共享 featured 快照，**禁止**为金框再拉全大厅 |
| `GET /api/characters/latest-badge` | 查询保持轻量；长尾交给 **用户/settings 的 abort**（P1-C）；评估前端 `staleTime` 避免无意义 stampede（产品可接受陈旧窗后） |

**验收**：

- `character_detail_api_p95_ms`、`lobby_api_p95_ms`、favorites p95 下降；p50 不显著恶化。
- ST-MINIAPP-3M 复发下降。
- 金框：同卡在列表与详情一致性人工抽检。
- 可见性：`enabled` / `archived_at` 过滤不变。

**回滚**：恢复原 handler 查询形状；featured 缓存为进程内，无迁移。

---

### 2.6 P1-S-HTTP — messages Consecutive HTTP（ST-MINIAPP-2G）（设计）

**根因**：`getContextBeforeTurn` 在 `windowStartTurn > 1`（已泄洪）时对 `current_chat_history` **两次 GET**（窗口行 + turn 1 开场白）。未泄洪只有 1 次，不触发该 Issue。

#### 方案（最小）

1. **单次查询**：`turn_index ∈ [windowStart, turnIndex) OR turn_index = 1`（同 session），内存拆分窗口行与 opening history；`windowStart ≤ 1` 行为与今日一致。
2. **复用开轮 RPC 的 `context_window_start_turn`**（若 RPC 已返回）：下传到 `getContextBeforeTurn`，去掉额外 `chat_sessions` 读（顺手减 RTT，非 Consecutive 主修）。
3. 保持现有 **5s** `abortSignal`；不把 history 做跨请求进程缓存。

#### 与 P1-A 的边界

- P1-S-HTTP 只消连续 HTTP / 多余会话读。
- P1-A（规则/设置/模型目录同轮复用）另批；验收只用 `backend_prepare_ms` 与 `context_http_count`，**不用** messages 总 p95。

**验收**：ST-MINIAPP-2G 下降；泄洪会话上 `current_chat_history` HTTP 从 2→1；开场白仍在；计费/取消/CAS 既有测试通过。

---

### 2.7 P1-N / P1-A / P1-B / P1-S（既有主线，Sentry 约束下的设计要点）

| 批次 | 在 Sentry 之后的定位 |
| ---- | -------------------- |
| P1-N | 开屏 240+720ms、创建 freshness；建议 **P1-N-DETAIL / P1-L-N1 有进展后**再改，避免把入口卡顿全推给动画 |
| P1-A | 同轮平台规则/设置/模型只读快照；须与 P1-S-HTTP、C-T2 对齐 signal |
| P1-B | 排名缓存 single-flight；与 featured 快照可同 PR 或紧随，注意陈旧窗运营审核 |
| P1-S | 仅证明绘制/终态（非 provider）瓶颈后动手 |

---

### 2.8 P2 / P2-X（旁路）

| 项 | 设计态度 |
| -- | -------- |
| 慢 SQL/索引 | 仅当 A–D 后仍有 EXPLAIN 证据 |
| webhook / miniapp-entry | P2-X：中位数已高，另开任务；不阻塞四主线 |

---

## 3. 推荐实施顺序（设计锁定，实施仍需 G1）

```text
P0-A（对照表/日志字段审） 
 → P0-B（有界等待）∥ P0-C（容量表）
 → P1-L-N1（前端，可最先落地）
 → P1-N-DETAIL + featured 快照（后端杠杆最大）
 → P1-L-TAIL（favorites 收窄；列表 single-flight）
 → P1-S-HTTP（合并 history 查询）
 → P1-C（超时/池参数，一次一维）
 → P1-A / P1-B / P1-N / P1-S
 → P2 / P2-X
```

前端 P1-L-N1 与后端 P1-N-DETAIL **无代码依赖，可并行**；合入后应用 E18 同查询验收，避免互相抢功。

---

## 4. 可靠性与失败路径（设计检查表）

- 超时：browser / proxy / Prisma / supabase 分层；abort ≠ 写回滚。
- 重试：仅安全读、总预算内、有限次；400/401/403 不重试。
- 金框降级：featured 缓存失败时允许有界旧快照或 `is_featured=false`，不得错误展示下架卡。
- `/chats` miss：占位头像可接受；不得因 miss 阻塞进入会话。
- 泄洪上下文：合并查询不得丢 turn1 opening；缺 opening 时行为与现 `assembleConversationContext` 一致。
- 计费：不改预留/快照/CAS 顺序；不盲重试生成。

---

## 5. 可验证性（实施前须可执行）

| 批次 | 命令/对照 | 人工 |
| ---- | --------- | ---- |
| P1-L-N1 | frontend typecheck/lint；Sentry 1Y | `/chats` Network 计数 |
| P1-N-DETAIL / TAIL | backend typecheck/test；Sentry 3M + p95 | 金框一致性、详情字段完整 |
| P1-S-HTTP | `ConversationHistoryRepository` / generate 既有测试；Sentry 2G | 泄洪会话开场白 |
| P1-C | 配置审 + TEST 小池；Sentry supabase >5s | 负载回落无需重启 |
| 跨包 | `pnpm -r typecheck`（若改 shared） | — |

不在本设计阶段创建新测试文件；实施时按主文档「测试范围审核」决定是否加回归。

---

## 6. 演进与回滚

- 无 migration、无新 DB 对象（本设计范围）。
- featured / ranking 均为进程内缓存：滚动发布自然失效。
- 方案 B（会话内嵌角色摘要）若启动：shared → backend → frontend，可独立回滚契约字段（可选字段向前兼容）。
- 超时参数：运维保存旧值；一次回滚一个维度。

---

## 7. 审核门禁（阻止实施的未决项）

- [ ] G1：产品/技术审核本文与主文档 §1.1/§8
- [ ] 大厅总预算 15s、supabase `db.timeout`、Prisma pool 数值
- [ ] featured 缓存陈旧窗是否与运营金框时效一致
- [ ] P1-L-N1 是否首批只做方案 A，或并行启动方案 B
- [ ] 灰度/停止阈值（主文档候选：p95 恶化 >10% 或错误率 +0.5pp）

未决不阻碍本文作为设计交付；**未勾选不得 `task start` 写产品代码**。
