# MiniApp 页面访问与冷启动：代码对照优化设计

状态：**设计指导，非规划任务、非已实施清单。**  
日期：2026-11-16。  
依据：[周末卡住分析](./analysis-and-remediation-2026-11-14-15.md)、[冷启动专项说明](./cold-start-optimization-2026-11-16.md)、当前 `packages/frontend` / `packages/backend` 源码核对。

## 1. 目标与边界

### 1.1 目标

- 降低 `/chats`、`/characters` 文档冷启动到 **content ready** 的 P95（第一阶段建议 ≤4s）。
- 降低 `/chats` 首屏与站内进房的无效等待，不靠提前 ready 或缩窄统计达标。
- 在失败路径上可恢复：分组不可用可降平铺；网络失败保留可展示的安全旧数据。

### 1.2 不做

- 不新建 Redis、第二套请求调度器、Service Worker、全站动态 SSR。
- 不调大 3 槽并发帽；不把全部 `GET /api/v1/conversations*` 升为 critical。
- 不把推荐序、钱包、权限、支付态写入跨用户或长期公共缓存。
- 不承诺「rewrite / Cache-Control / 再分包」固定省 N 秒。
- 不重复添加 Next14 已默认的 lucide `optimizePackageImports`；不把关键列表拆成串行动态 chunk。

### 1.3 已在代码落地（先验收，勿重复造）

| 能力                      | 代码位置                                            | 说明                                               |
| ------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| `/` cookie 内部 rewrite   | `packages/frontend/next.config.mjs`                 | 不再依赖根路径 307 再取文档                        |
| History 规范路径          | `src/lib/landing-route.ts`、`src/app/providers.tsx` | `replaceState`，不二次 RSC                         |
| groups/flat 首页 critical | `src/lib/api/conversation-folders.ts`               | `pageParam===0` → critical                         |
| groups 指标独立           | `src/lib/perf/api-timing.ts`                        | `conversation_groups`                              |
| 大厅 localStorage 快照    | `src/lib/api/characters.ts`                         | `initialData` + idle 写入；`refetchOnMount: false` |
| 推荐 450ms 公开头 hedge   | `src/lib/api/lobby-recommendations.ts`              | UI 可较早用公开头                                  |
| 底栏受限预热              | `src/components/nav/bottom-nav.tsx`                 | Android 后台最多 1 个 route                        |

**发布门禁：** 上述 11-16 变更若尚未有生产 release 同口径样本，应先发布并观察 ≥24h（每平台/路径成功 N≥100，iOS 不足延长），再叠加大改。

---

## 2. 问题模型（开发对照）

```text
Telegram 入口
  → 文档到达（redirect / HTML TTFB / 脚本）     ← 本地缓存与客户端预热帮不上
  → Providers / 路径规范化
  → 首屏 critical 请求 + 旁路抢槽请求           ← 本设计主战场
  → 内容 ready（真实列表/大厅数据，非骨架）
```

同次启动证据表明：最终文档发起前可空等约 4.8–5s；脚本全缓存也救不了该段。因此：

- **文档链**：以发布后同次 redirect/pre-fetch/request-wait 证据为准，再决定边缘/入口；
- **内容链**：优先消灭与 P0 抢槽的旁路、分组超时不可降级、summary 拖包。

---

## 3. 批次设计（按实施顺序）

### 批次 A — `/chats` 停止无条件拉大厅全表（P0，Frontend）

**现状**

- `conversation-row.tsx` 的 `useLobbySummaryLookup` 无条件调用 `useCharactersQuery(DEFAULT_LOBBY_SORT)`（`recommended`）。
- 无 v5 本地快照时，大厅请求为 **critical**，与 groups 首屏并行，挤占 3 槽中为 P0 保留的槽。
- 有快照时因 `refetchOnMount: false` 通常不发网，但不能依赖「用户一定有快照」。

**方案**

1. Lookup 改为：
   - 若 React Query / 持久快照已有可用目录 → 同步构建 `byId`；
   - 否则 **不** 在会话列表首屏发起全表 critical 拉取；
   - 缺失角色用现有 `useCharacterQuery` 补齐，且保持「lookup pending 时不发 N 个详情」闸门，或将补齐标为 `normal`/`background` 并限流。
2. 可选：只读已有 `public-head` / 列表行已带字段，禁止冷启动再打 `/api/lobby-characters` 全表。
3. 复用 `characterKeys` 与现有 persist 读写；不新增 storage schema，除非证明现有 key 不够用。

**验收**

- 无大厅快照时，首屏网络以 groups/flat critical 为主；不应再出现与之并行的大厅全表 critical。
- 有快照时头像/名仍可展示；缺失角色不触发请求风暴。
- `@chats` 相关 UI 测试与既有 Vitest 通过。

**回滚**

- 恢复 `useLobbySummaryLookup` 原实现即可；无 DB/迁移。

---

### 批次 B — 分组超时可降级 + summary 不拖包（P0/P1，Backend + Frontend）

**现状**

- `ChatFolderRepository.listGroups` 使用短 RPC timeout；abort 后常落到非 `folders_unavailable`，路由 `throw` → **500**。
- 前端 `use-conversation-view.ts` 的 `groupsUnavailable` **仅认 404/503**，500 不走平铺降级。
- `routes/conversation-folders.ts` 中 `listGroups`、`displayName`、`readFolderSummary` 为 `Promise.all`：summary 失败可省略，**变慢仍阻塞整包**。

**方案**

1. Backend：RPC/依赖超时或「分组功能暂不可用」统一映射为已有 `folders_unavailable` → HTTP **503**（复用 `sendChatFolderError` / 既有错误码表）。真实编程错误、鉴权失败不伪装成不可用。
2. Frontend：继续只对约定不可用状态降平铺；**不要**把任意 500 当降级。可选同时认稳定业务码。
3. summary：
   - 首屏 `summary=1` 使用独立短超时；超时/失败返回无 `folder_summary` 的成功 groups 包；
   - 或将 summary 移出关键 `Promise.all`，标签后补；
   - **禁止**为 summary 再打一遍全量列表。
4. 不改用户「按角色」偏好存储；降级不清除列表/草稿/滚动位置。

**验收**

- 人为制造 listGroups 超时：客户端收到 503/`folders_unavailable`，UI 平铺可用。
- summary 慢：groups 主体仍在短预算内返回；标签可晚出或缺失。
- 未知 500 仍展示错误，不静默吞掉。

**回滚**

- 前后端各自回退本批次；用户分组数据保留。

**契约**

- 优先复用已有 `folders_unavailable`；若必须扩展错误形状，先改 `packages/shared` 再改 producer/consumer。

---

### 批次 C — 推荐 entry 超时与 critical 占用（P1，Frontend）

**现状**

- `lobby-recommendations.ts` 默认 `MANUAL_RECOMMENDATION_TIMEOUT_MS = 5000`。
- 450ms hedge 已让 UI 可走公开头，但私有 recommendation 请求仍可能占 critical 至 5s。

**方案**

1. 区分：
   - **entry open/resume**（冷启动自动）：更短预算（与产品/spec 对齐，例如 1.5s），超时后明确走公开头/已有缓存，不无限占槽；
   - **手动 refresh / undo**：保持 5s。
2. 不把 `recommended` 响应改为公共 CDN 缓存；身份批次禁止进入共享缓存。
3. 复用现有 hedge 与失败保留旧 batch 逻辑。

**验收**

- 自动 open 在短预算后不再占用 critical；手动刷新行为与现网一致。
- 大厅 content ready 定义不变（真实可展示数据，非骨架）。

**回滚**

- 恢复单一 5s 超时常量。

---

### 批次 D — 有限预热与进聊 placeholder（P2，Frontend）

**仅在 A/B 落地且有证据后做。**

1. **`/chats` 数据预热**
   - 不在 Android `touchstart` 齐射。
   - 可在 `afterEntryBackground` + 导航安静窗之后，对「落地 chats 或近期有列表 cache」的用户预取第一页 groups/flat。
   - 必须尊重 `byCharacter` 偏好与当前 folder；预热失败静默。

2. **进聊角色 placeholder**
   - 从大厅/列表已有摘要灌入 `characterKeys.detail` 的 placeholder/initialData。
   - 完整字段仍以详情接口为准；版本卡/session 定制字段不得被摘要覆盖成权威。

3. **会话列表本地快照（可选，更谨慎）**
   - 仅同用户作用域、短 TTL、契约校验后的只读摘要。
   - 进入后仍 critical 回源；失败保留旧列表并提示更新失败。
   - **禁止**持久化余额、VIP、未读真相源。

**验收**

- 预热不增加首屏 stall/error 率；不与 A 的「禁止抢槽」冲突。
- 进聊首屏空壳时间下降，且无串角色/串会话。

---

### 批次 E — 文档/边缘（仅证据驱动，P1 诊断后）

**触发条件：** 11-16 发布后同次启动仍显示「最终文档 TTFB / redirect」为大头，且生产响应头证明静态页非边缘 HIT。

**可评估**

- 仅对无用户私有内容的静态壳路径（如 `/chats`、`/characters`）显式短/中 `Cache-Control` / `CDN-Cache-Control`。
- `/` 依赖 cookie rewrite：必须正确 `Vary` 或不对 `/` 做跨用户共享缓存。

**不做**

- 指望 Railway 源站 `s-maxage` 充当 CDN。
- 鉴权 API 公共缓存。

---

## 4. 复用与约束清单

| 能力              | 复用位置                                                | 约束                                         |
| ----------------- | ------------------------------------------------------- | -------------------------------------------- |
| 请求优先级与 3 槽 | `request-concurrency.ts`、`client.ts`                   | 显式 `queuePriority`；不全局抬 conversations |
| 大厅缓存          | `characters.ts`                                         | idle 写入；损坏/过期删除；隐私模式仅内存     |
| 分组降级          | `use-conversation-view.ts`                              | 扩大不可用判定须与 Backend 契约一致          |
| 入口分波          | `entry-phase.ts`、`navigation-quiet-window.ts`          | 预热必须等安静窗                             |
| 观测              | `api-timing`、`onAttempt`/`onDispatch`、Faro/Sentry     | 排队过期要可观测；新旧 groups 分类不可混比   |
| UI 验收           | `packages/ui-tests` `@chats` / `@startup` / `@roleplay` | 扩展 fixture，不搭一次性 mock 后端           |

---

## 5. 日志与失败路径（开发必须覆盖）

- groups 超时 → 503/`folders_unavailable`：记可恢复不可用，不记成未分类 500 风暴。
- 真实 DB/编程错误：保持 warn/error + 稳定错误码。
- 取消/离页：与 deadline 失败区分（若本批次触及详情链路，沿用 overnight 分类原则）。
- 禁止日志：token、完整 initData、支付密钥、大响应正文、私人列表全文。
- 原始错误用 `{ err }`，不用 `String(err)`。

---

## 6. 验证口径

| 项       | 要求                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------- |
| 基线     | 2026-11-14 00:00—11-16 00:00（Asia/Shanghai）报告数值；不重算冒充新基线                                  |
| 页面     | Grafana 成功 foreground 的 document→ready / 导航 P95；分 Android/iOS                                     |
| API      | Sentry 成功 attempt 的 queue/headers/body；groups 独立分组                                               |
| 本地     | typecheck、相关 Vitest、`pnpm test:ui` 按改动范围；**不能**证明线上 ≤4s                                  |
| 停止条件 | hydration/错页、身份或支付回跳异常、错误率上升、同平台 P95 回退 >10% 且 ≥200ms（样本充足时）→ 回滚该批次 |

阶段 P95 **不相加、不相减**。热缓存样本不得冒充无快照首载。

---

## 7. 建议实施顺序

```text
0. 确认 11-16（rewrite + chats critical）生产 release 与 24h 样本
1. 批次 A：/chats 大厅 lookup 去 critical 抢槽
2. 批次 B：groups 超时 503 + summary 短预算
3. 批次 C：推荐 entry 短超时
4. 批次 D：有限预热 / 进聊 placeholder /（可选）会话摘要快照
5. 批次 E：仅当文档链证据充分时评估 HTML 边缘头
```

每批次可独立提交与回滚；避免与计费、迁移、入口大改同一 PR 捆绑。

---

## 8. 开发检查清单（开 PR 前）

- [ ] 对照生产/目标分支 SHA，确认未重复实现已落地项
- [ ] 首屏 critical 列表写明：保留哪些、降级哪些、禁止哪些旁路
- [ ] 用户态数据作用域（tg/user id）与失效策略已写清
- [ ] 失败路径：超时、503、未知 500、无快照、storage 拒绝
- [ ] 未新增无界预热、未调大并发帽、未改 ready 语义
- [ ] 相关 typecheck / 既有测试 / 适用 `@chats`/`@startup` 已跑
- [ ] PR 说明含：预期指标、回滚方式、是否触及 Backend 契约

---

## 9. 一句话

**先验收入口与首屏 critical；开发重点转到「会话列表旁路抢槽、分组超时降级、summary 拖包」；缓存/分包/边缘头只做有证据的增量，且永不放松 content ready 与鉴权边界。**
