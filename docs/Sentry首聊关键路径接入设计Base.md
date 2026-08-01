# Sentry 首聊关键路径接入设计 Base

更新时间：2026-07-31  
状态：代码已实现，待 Development 部署与真机验收

## 0. 目标、口径与边界

本方案只回答一个核心问题：

> 用户点角色卡后，为什么迟迟看不到对话？时间具体消耗在哪个阶段、哪个事件或哪个服务？

### 0.1 核心观测区间

- 起点：用户产生“进入角色”意图，执行 `router.push('/tavern/<characterId>')` 之前。
- 终点：聊天页已经提交可见状态，开屏遮罩退出，用户实际能看到对话。
- 核心 Transaction：`tavern.first_chat_open`
- 统计对象：每次 MiniApp WebView 生命周期内的首次进卡。
- 重试：每次重试建立新的 attempt，通过同一个 journey ID 关联。

若无法在点击入口取得起点（例如用户通过直链进入 `/tavern/<id>`），以 `page_mount`
作为降级起点，并记录 `entry_source=direct`。

### 0.2 冷启动的处理方式

ST 冷启动不再单独作为本方案的主链路。

- 点卡时 ST 尚未可交互：剩余冷启动时间自然落入 `wait_gate`。
- 点卡时 ST 已可交互：`wait_gate` 接近 0。
- 点卡前已经发生的 iframe/ST 启动阶段不能伪装成首聊 Transaction 的子 Span，只作为
  `bridge_phase_at_click`、`boot_elapsed_ms_at_click` 等上下文。

这样统计的是用户真正感知到的“点卡后等待”，不会把点卡前已被大厅浏览吸收的时间算入。

### 0.3 本版覆盖

- 浏览器前端：首聊 Transaction、关键路径 Span、结构化事件。
- Fastify backend：错误、关键接口 Span、精选结构化日志。
- sync-engine provision API：单卡下发的服务端 Span、错误和精选日志。
- 浏览器 → Fastify → sync-engine 的 Trace 和业务关联 ID 传播。
- 现有 `[iframe-timing]` 与 Sentry 暂时双写，完成真机数据对照后再决定移除。

### 0.4 本版不覆盖

- 不给 SillyTavern vendor 注入 Sentry SDK。
- 不把全部 Pino 日志无差别上传 Sentry。
- 不把普通大厅请求、支付等非首聊请求纳入本 Transaction。
- `/api/init-st-session` 通常早于点卡，不强行挂到首聊 Trace；它通过
  `boot_session_id` 与首聊关联。

**为什么这样设计**：首聊路径跨浏览器、Bridge、Fastify 和 sync-engine，但用户关注的是
点卡后的阻塞时间。严格限定边界可以避免冷启动全长、后台 provision 和首聊耗时相互污染。

---

## 1. Transaction、Span 层级与命名

### 1.1 顶层 Transaction

```text
tavern.first_chat_open
```

建议属性：

```text
journey_id
attempt_id
boot_session_id
user.id                    # Telegram ID
miniapp_user_id            # 后端 miniapp.users UUID，取得后才补充
character_id
entry_source               # gallery | detail | direct | retry
platform                   # Android | iOS | Desktop | other
environment
release
bridge_phase_at_click      # disconnected | connecting | handshake | interactive | ready
boot_elapsed_ms_at_click
is_first_chat=true
result                     # success | degraded | failed | cancelled | timed_out
```

Transaction 名和 Span 名不得包含用户 ID、角色 ID、URL 参数或错误文本，避免高基数。

### 1.2 关键路径 Span 树

```text
tavern.first_chat_open
├─ ui.route_transition
├─ bridge.wait_gate
├─ chat.prepare
│  ├─ api.ensure_character_wait
│  └─ api.latest_chat_lookup
├─ bridge.select_character
│  ├─ bridge.character_resolve
│  ├─ bridge.select_by_id
│  └─ bridge.new_chat_or_clear
├─ bridge.open_chat                 # 仅存在历史目标会话时
│  └─ bridge.fallback_select        # openChat 失败时才出现
└─ ui.render_chat
```

阶段边界：

| Span                        | 起点                 | 终点                         | 说明                           |
| --------------------------- | -------------------- | ---------------------------- | ------------------------------ |
| `ui.route_transition`       | 点击入口             | `page_mount`                 | 包含路由切换和 React 页面挂载  |
| `bridge.wait_gate`          | `page_mount`         | `gate_open`                  | 等待 `interactive` 或 `ready`  |
| `chat.prepare`              | `gate_open`          | ensure 与 latest-chat 均完成 | 两项可并行，不把并发耗时相加   |
| `api.ensure_character_wait` | 开始等待共享 Promise | Promise settle               | 表示它对点卡关键路径的实际阻塞 |
| `api.latest_chat_lookup`    | 请求开始             | 请求结束                     | 查找需要恢复的最近会话         |
| `bridge.select_character`   | `select_start`       | `select_end`                 | Bridge RPC 选角色              |
| `bridge.open_chat`          | openChat 发起        | openChat 完成或失败          | 仅历史会话路径存在             |
| `bridge.fallback_select`    | openChat 失败        | fallback 完成                | 标记恢复成本                   |
| `ui.render_chat`            | Bridge 操作全部完成  | 对话实际可见                 | 不只记录 `setState` 调用时刻   |

`bridge.character_resolve`、`bridge.select_by_id`、`bridge.new_chat_or_clear` 沿用已有
`sel_*` 打点，由父窗口根据 ST 扩展回传的时间戳创建，不在 ST vendor 中安装 SDK。

### 1.3 预取 ensure 的特殊口径

角色预览浮层可能在点卡前已经启动 `prefetchEnsureStCharacter`：

- Sentry 后端 HTTP Span 可以早于首聊 Transaction，不能伪造为它的子 Span。
- 首聊内只记录 `api.ensure_character_wait`，即点卡后真正等待共享 Promise 的时间。
- 增加 `ensure_source=prefetched|on_demand` 和 `ensure_result=written|skipped|missing|error`。

**为什么这样设计**：关键路径 Span 必须表达用户实际等待，而不是把并行请求时长相加。
预取已运行的部分不是点卡后成本，只应记录剩余等待。

---

## 2. 各服务埋点位置与职责

### 2.1 浏览器前端

主要修改位置：

- `packages/frontend/src/components/characters/character-gallery.tsx`
- `packages/frontend/src/components/characters/character-detail-sheet.tsx`
- `packages/frontend/src/app/tavern/[characterId]/page.tsx`
- `packages/frontend/src/lib/sentry/bridge-telemetry.ts`
- 建议新增 `packages/frontend/src/lib/sentry/first-chat-telemetry.ts`

职责：

1. 点击入口生成 `journey_id`、首个 `attempt_id` 并开始 Transaction。
2. 直链进入时在 `page_mount` 降级创建 Transaction。
3. 页面重试时保留 `journey_id`，生成新的 `attempt_id`。
4. 管理 Span 父子关系和所有终止路径。
5. 将 `gate_open`、`openChat`、fallback 和真实 render 补成 Span。
6. 将已有 `sel_*` 子相位转换为 `bridge.select_character` 的子 Span。

现有 `bridge-telemetry.ts` 中多个 `forceTransaction: true` 的独立 Span，应调整为：

- 首聊阶段全部成为 `tavern.first_chat_open` 的子 Span。
- `bridge.boot` 继续是独立冷启动 Transaction，不强行改为首聊子 Span。

### 2.2 Next.js Route Handler

`packages/frontend/src/app/api/init-st-session/route.ts` 通常发生在点卡之前，因此不属于
首聊 Span 树。本轮只做基础观测和关联：

- 透传 `X-Request-Id`、`X-Boot-Session-Id`、`sentry-trace`、`baggage`。
- 捕获代理失败、上游非 2xx、响应缺少 Cookie。
- 不把 InitData、Cookie 或上游响应正文上传 Sentry。

如果点卡时 session 尚未完成，首聊只通过 `bridge.wait_gate` 体现用户等待；再通过
`boot_session_id` 跳转到对应 session 事件排查根因。

### 2.3 Fastify backend

建议引入与前端同主版本的 `@sentry/node`，在任何 Fastify、Pino、Prisma 等业务模块导入前
完成初始化。Fastify 5 可使用 SDK 的 diagnostics channel 自动请求追踪；具体 API 以安装时
最新 SDK 文档和类型定义为准。

主要位置：

- 启动前 instrumentation 文件。
- `packages/backend/src/app.ts`
- `packages/backend/src/routes/bridge.ts`
- 最近会话查询对应 route。

首聊重点接口：

```text
POST /api/bridge/st-character/:characterId
GET  /api/users/chats/latest
```

`st-character` 内部子 Span：

```text
backend.auth.telegram
backend.user.resolve
backend.character.validate
backend.provision.ensure_character
```

现有 handler 已 catch 后自行返回 500，这类异常不会自然到达 Fastify 顶层 error handler，
因此 catch 中必须显式 `captureException`，并带 `attempt_id`、`request_id`、
`miniapp_user_id`、`character_id`。

### 2.4 sync-engine

建议同样引入 `@sentry/node`，在 `provision-api/run.ts` 加载业务模块前初始化。

重点链路：

```text
POST /provision/:userId/character/:characterId/sync
```

建议 Span：

```text
sync.ensure_character
├─ sync.character.lookup
├─ sync.character.download_or_read
├─ sync.character.write
└─ sync.character.verify
```

实际子 Span 应以 `ensureCharacterProvisioned()` 和 `writeCharacterById()` 当前真实步骤为准，
不为了表面完整创建没有实际边界的 Span。

### 2.5 ST iframe / Bridge

- Bridge RPC 不经过 HTTP，不能依赖自动分布式追踪。
- 父窗口在发送 RPC 时创建 Span，并把 `attempt_id`、Bridge `requestId` 放入 Span 属性。
- ST 扩展继续通过现有 postMessage debug timing 返回 H1/H3/H2 子相位。
- 不修改 SillyTavern vendor，不在 iframe 内重复安装 Sentry SDK。

**为什么这样设计**：每个服务只记录自己能可靠观测的时间。浏览器负责用户等待和 Bridge，
Fastify 负责 API 编排，sync-engine 负责实际 provision，避免同一耗时被多个层级重复解释。

---

## 3. Trace 与关联 ID 的跨服务传播

### 3.1 ID 体系

| 字段                | 生命周期                | 用途                       |
| ------------------- | ----------------------- | -------------------------- |
| Sentry `trace_id`   | 一次 attempt Trace      | Sentry 内自动串联 Span     |
| `journey_id`        | 首次点卡到最终成功/放弃 | 关联多次重试               |
| `attempt_id`        | 每次进入或重试          | 本方案的主要业务关联键     |
| `boot_session_id`   | 一次 iframe/Bridge boot | 关联点卡前冷启动与 session |
| `request_id`        | 单次 HTTP 请求          | 对齐 Fastify/Railway Pino  |
| `bridge_request_id` | 单次 postMessage RPC    | 对齐父窗口与 ST 扩展       |

不使用 Telegram ID、角色 ID 充当链路 ID。

### 3.2 Header

浏览器 → Fastify：

```text
sentry-trace
baggage
X-Request-Id
X-First-Chat-Journey-Id
X-First-Chat-Attempt-Id
X-Boot-Session-Id
```

Fastify → sync-engine 继续透传同一组 Header。Fastify 的 `genReqId` 继续优先复用
`X-Request-Id`。

需要同步把以下字段加入 CORS `allowedHeaders`：

```text
sentry-trace
baggage
X-First-Chat-Journey-Id
X-First-Chat-Attempt-Id
X-Boot-Session-Id
```

### 3.3 传播实现原则

- 浏览器只在当前首聊 Span 激活时调用 `Sentry.getTraceData()`，避免错误复用其他页面 Trace。
- Fastify 从入站 `sentry-trace`、`baggage` 继续 Trace。
- Fastify 调 sync-engine 时，从当前 active Span 生成新的下游 Trace Header。
- 业务 ID 单独传播，不能用来替代 Sentry Trace。
- 若 Sentry Header 因 CORS、采样或 SDK 行为缺失，仍可使用 `attempt_id + request_id` 排查。

**为什么这样设计**：Sentry Trace 适合性能树，但会受采样和运行时上下文影响；业务关联 ID
稳定且可进入 Pino。两者并存才能保证 Sentry 和 Railway 日志都可查。

---

## 4. Log、Error 与 Span 的边界

### 4.1 Span

Span 用于“花了多久”，只覆盖有明确开始和结束边界的操作。正常成功不需要再发送一组
start/done Error Event。

### 4.2 结构化 Log

只发送关键状态、分流和恢复结果：

```text
tavern.first_chat.started
tavern.gate.opened
tavern.gate.stalled
tavern.ensure_character.failed
tavern.select_character.stalled
tavern.open_chat.failed
tavern.open_chat.fallback_succeeded
tavern.first_chat.completed
tavern.first_chat.failed
tavern.first_chat.cancelled
backend.ensure_character.failed
sync.ensure_character.failed
```

每条事件至少包含：

```text
service
event
stage
result
journeyId
attemptId
bootSessionId
requestId
characterId
durationMs
elapsedMs
environment
release
```

成功路径以一个 `tavern.first_chat.completed` 汇总事件为主，包含各阶段时长；不为每个 Span
重复发送 start/done Log。

### 4.3 Error Event

以下情况进入 Sentry Issues：

- 未处理异常、未处理 Promise。
- Fastify 或 sync-engine 未处理的 5xx。
- 已被 handler catch、但导致首聊失败的真实 Error。
- ST session、ensure、select 的终态失败。

以下情况不单独创建 Issue：

- `gate_stall`、`select_stall` 阈值告警，但后续恢复成功。
- 用户切页导致取消。
- ensure 失败但缓存兜底后 select 成功。
- openChat 失败但 fallback 成功。

这些情况用 warning/error Log 和 Span 状态表达，防止 Issues 被可恢复事件淹没。

### 4.4 Pino 策略

- Railway Pino 继续作为完整后端日志源。
- Base 版不启用“全量 Pino → Sentry Logs”。
- Sentry 只通过专用 adapter 发送上述首聊关键事件。
- 后续若启用 `pinoIntegration`，必须限定 logger 或 level，并先评估额度和重复日志。

项目当前 Pino `10.3.1` 满足现代 Sentry Pino integration 的版本范围，但全量接入仍可能产生
大量无关日志，因此不是 Base 默认方案。

**为什么这样设计**：Span、Log、Issue 各自回答不同问题。若正常阶段也大量写 Log，数据会
重复、额度快速消耗，真正的失败信号反而更难发现。

---

## 5. 成功、停摆、失败、取消和重试规则

### 5.1 成功

满足以下条件后结束 Transaction：

1. ensure/latest-chat 准备完成或已按现有策略降级；
2. selectCharacter 成功；
3. 若存在目标历史会话，openChat 或 fallback 成功；
4. 聊天状态已提交并完成至少一次可见帧；
5. 记录 `result=success` 或 `result=degraded`。

以下情况记为 `degraded`：

- ensure 失败，但角色缓存兜底后首聊成功。
- openChat 失败，但 fallback select 成功。
- 期间发生 gate/select stall，最终仍恢复成功。

### 5.2 Stall

- `gate_stall`：点卡后 15 秒仍未 `gate_open`。
- `select_stall`：闸门打开后 25 秒仍未完成 select。

Stall 是检查点，不立即结束 Transaction，因为现有 Bridge 可能随后自愈成功。处理方式：

- 写 warning Log。
- 在当前 Span 设置 `stall_observed=true`、`stall_count`。
- 保留现有 iframe 诊断收割。
- 最终由 success、failed、cancelled 或 hard timeout 结束。

### 5.3 失败

以下情况以 `result=failed` 结束：

- `select_error` 且没有成功 fallback。
- Bridge 进入终态 `disconnected`，页面确认展示失败状态。
- session/iframe 永远未就绪并达到 hard timeout。
- render 阶段抛错，无法展示对话。

失败 Transaction 应设置错误 Span 状态，并捕获导致失败的原始 Error；禁止只传 `String(err)`
而丢失 stack/cause。

### 5.4 取消

用户离开页面、切换角色、组件卸载时：

- 当前 attempt 结束为 `cancelled`。
- 不创建 Issue。
- 记录已完成阶段、取消时所在阶段和 elapsed time。

### 5.5 重试

- 点击“重试”时，旧 attempt 结束为 `replaced_by_retry`。
- 保留 `journey_id`，生成新 `attempt_id` 和新 Transaction。
- 记录 `attempt_number`。
- 整页 reload 后如果要继续关联，`journey_id` 需要暂存于 `sessionStorage`；成功后立即删除。

### 5.6 防止孤儿 Span

增加首聊 hard timeout，Base 建议 90 秒：

- 到期结束所有活动 Span。
- Transaction 记为 `timed_out`。
- 上报一次 `tavern.first_chat.failed`。

**为什么这样设计**：15/25 秒 stall 是诊断阈值，不等于最终失败。过早结束会丢失“卡住后
恢复”的完整耗时；完全不设上限又会留下孤儿 Transaction。

---

## 6. Sentry 查询、Dashboard 与统计口径

### 6.1 基础查询

成功首聊：

```text
transaction:tavern.first_chat_open is_first_chat:true result:[success,degraded]
```

点卡时 ST 尚未就绪：

```text
transaction:tavern.first_chat_open bridge_phase_at_click:!ready
```

停摆后恢复：

```text
transaction:tavern.first_chat_open stall_observed:true result:[success,degraded]
```

指定用户/角色/attempt：

```text
user.id:<TelegramID>
character_id:<UUID>
attempt_id:<ID>
```

### 6.2 Dashboard Base

建议至少包含：

1. 首聊总耗时 P50 / P75 / P80 / P90。
2. 各关键阶段 P50 / P75 / P80 / P90。
3. Android 与 iOS 分平台对比。
4. `bridge_phase_at_click` 分组对比。
5. 成功率、degraded 率、失败率、取消率。
6. gate stall 和 select stall 比例。
7. ensure 预取与现场发起的耗时对比。
8. openChat fallback 发生率及额外耗时。
9. backend 和 sync-engine 错误数量。

### 6.3 样本口径

- 总耗时分位数只统计 `success|degraded`，失败、取消、超时单列。
- 平台至少分 Android/iOS；Desktop 样本不足时只作旁证。
- 报告 P50、P75、P80，P90 用于识别重尾。
- `entry_source=direct` 与正常点卡可分组，不混淆 route transition。
- `attempt_number>1` 单列，避免重试样本拉高普通首试耗时。
- `bridge_phase_at_click` 必须分组：
  - `interactive|ready`：不含剩余冷启动。
  - 其他状态：包含剩余冷启动，主要体现在 `bridge.wait_gate`。
- 与现有 baseline 对照时，仅比较定义相同的阶段；不能把
  `bridge_start→APP_READY` 与 `click→chat_ready` 直接比较。

### 6.4 采样

Base 建议 development 保持 100%。

production 初始建议：

- `tavern.first_chat_open`：100%，先获得稳定基线。
- 首聊相关 backend/sync-engine Trace：100%。
- `/health`、debug endpoint：0% Trace。
- 高频 `/api/bridge/st/*` 代理流量不做全量 Trace，避免数百个 ST 请求消耗额度。
- Error Event 保持 100%。

积累至少 100 个成功首聊样本后，再根据额度调整 traces sampler。

**为什么这样设计**：成功耗时、失败率和取消率是不同统计问题，混合计算会产生错误结论。
分平台、点卡时 Bridge 状态和重试次数，是判断“冷启动残余”与“进卡流程自身”最关键的维度。

---

## 7. 数据安全

沿用现有前端 sanitizer，并在 backend/sync-engine 复用同一份字段规则：

- 禁止上传 `X-Init-Data`、Authorization、Cookie、Token、Secret、`tgWebAppData`。
- 禁止记录 ST Cookie、CSRF Token、请求完整 Header 和上游响应正文。
- URL query/fragment 继续清理。
- 允许 Telegram ID 作为 Sentry User ID。
- `character_id`、`miniapp_user_id`、request/attempt/journey ID 可作为结构化属性。
- 默认不上传请求 body；确需开启 Sentry HTTP body 采集时必须另行审查。

---

## 8. 实施顺序

1. 前端建立单一首聊 Transaction 和完整结束规则。
2. 补齐 gate、latest-chat、openChat、fallback、render Span。
3. 统一 journey/attempt/boot/request/bridge ID。
4. 接入 Fastify Sentry，先覆盖 `st-character` 和 latest-chat。
5. 接入 sync-engine Sentry，覆盖单卡 provision。
6. 打通 Trace Header、业务 Header 和 CORS。
7. 真机验证成功、stall→恢复、失败、取消、重试五类路径。
8. 建 Dashboard，与 `[iframe-timing]` 双写数据对照。
9. 数据一致后再评估移除临时 debug POST。

---

## 9. 已确认决策与实施期验证项

已确认：

1. “首次聊天”指每次 MiniApp WebView 生命周期内第一次点卡。
2. 终点采用开屏退出后的首次可见帧；旧时刻保留为 `chat_state_ready`。
3. 本轮同时接入 Fastify backend 与 sync-engine Sentry。
4. 三端继续共用 `wangqiao/st-miniapp`，通过 `service` 字段区分。
5. 首聊 Transaction hard timeout 为 90 秒。
6. ensure 失败但缓存兜底成功进入聊天，记为 `degraded` 成功。

实施期仍需验证：

1. **P80 展示能力**  
   baseline 要求 P80。需要在当前 Sentry 套餐的 Discover/Dashboard 中验证是否支持自定义
   percentile；若 Dashboard 不支持，Base 建议保留 P50/P75/P90 面板，并通过 Discover
   定期导出 P80，而不是改变统计口径。

---

## 10. 实施记录

### 10.1 已落地

- 前端 `tavern.first_chat_open` 根 Transaction、90 秒 hard timeout 与首聊 session 口径。
- `route_transition`、`wait_gate`、`prepare`、`ensure`、`latest_chat`、`select`、
  `open_chat`、fallback 和真实可见帧 `render_chat` Span。
- ST select 内部 `character_resolve`、`select_by_id`、`new_chat_or_clear` 子阶段。
- success、degraded、stall、failed、cancelled、retry 的结束规则。
- `journey_id`、`attempt_id`、`boot_session_id`、HTTP request ID、Bridge request ID 分层。
- 浏览器 → Fastify → sync-engine 的 `sentry-trace`、`baggage` 和业务 Header 传播。
- Fastify 与 sync-engine `@sentry/node` 初始化、错误捕获、关键 Span 和精选结构化 Log。
- frontend/backend/sync-engine 共用 `service` 字段。
- 共用 sanitizer，继续清理 InitData、Cookie、Token、Secret 和 URL 敏感参数。
- Railway backend、st-bundle 环境变量模板。
- 首聊生命周期及 Header 传播单元测试。

### 10.2 部署前配置

Railway Development 的 backend 与 st-bundle 服务均需配置：

```text
SENTRY_DSN=<wangqiao/st-miniapp DSN>
SENTRY_ENVIRONMENT=development
```

`SENTRY_RELEASE` 可不填，代码会回退到 Railway 的 `RAILWAY_GIT_COMMIT_SHA`。Production
部署时将 environment 改为 `production`。

### 10.3 真机验收重点

1. 首次点卡后出现一个 `tavern.first_chat_open`，后续同一 WebView 再次进卡不重复记为首聊。
2. 根 Transaction 下能看到关键路径 Span，且 `click/page_mount → visible frame` 总耗时合理。
3. 点卡时 Bridge 未 ready 的样本，主要耗时落入 `bridge.wait_gate`。
4. ensure 现场请求能串起 frontend → backend → sync-engine Trace。
5. ensure 预取早于点卡时，首聊只记录剩余 `ensure_character_wait`，后台请求通过
   `boot_session_id` 关联。
6. ensure 失败但缓存兜底成功时，最终 `result=degraded`。
7. gate/select stall 后恢复时 Transaction 不提前结束，最终仍保留完整耗时。
8. Replay、Transaction、backend Log 和 sync-engine Log 可用 `attempt_id` 交叉查询。
9. Sentry 中不出现 InitData、ST Cookie、Authorization 或 token 明文。
10. 验证当前套餐 Dashboard 是否支持 P80。
