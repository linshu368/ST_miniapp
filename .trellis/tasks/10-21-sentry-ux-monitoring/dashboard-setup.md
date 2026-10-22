# Sentry 看板搭建清单（照着点）

Sentry MCP 没有创建看板的工具，需在界面手建。org `wangqiao`，project `st-miniapp`。

入口：Sentry 左侧 **Dashboards** → **Create Dashboard**。每张图点 **Add Widget**，按下面逐字填。

**图表 1–4 现在就能建**（用现有数据），**5–12 要等 PR #444 上线**后才有数据——可以先建好，上线后自动填充。

建议分两个看板：**「用户体感」**（1–8）和**「服务端与稳定性」**（9–12）。

---

## 看板一：用户体感

### 1. 首屏 LCP p75（现在可建）

- Dataset: `Spans`
- Query: `is_transaction:true span.op:pageload environment:production`
- Visualize: `p75(measurements.lcp)`
- Group by: `transaction`
- Display: Line chart，Time range 14d

> 基线（2026-10-21，14 天）：`/` 4401ms、`/chats` 5140ms、`/create` 4152ms、`/chat/:characterId` 2604ms。Google 的「良好」阈值是 2500ms，目前四个主页面都没达标。

### 2. 页面加载耗时 p95（现在可建）

- Dataset: `Spans`
- Query: `is_transaction:true span.op:pageload environment:production`
- Visualize: `p95(span.duration)`
- Group by: `transaction`

> 基线：`/` p95 = 20028ms。这就是用户说的"打不开"。

### 3. 后端接口 p95（现在可建）

- Dataset: `Spans`
- Query: `is_transaction:true span.op:http.server environment:production !transaction:["POST /api/v1/conversations/:id/messages","POST /api/v1/conversations/:id/regenerate"]`
- Visualize: `p95(span.duration)`
- Group by: `transaction`
- Sort: `-p95(span.duration)`，Limit 10

> 排除对话生成（p50 就有 16 秒，属正常），否则看板全被它占满。

### 4. 慢请求数量趋势（现在可建）

- Dataset: `Spans`
- Query: `is_transaction:true span.op:http.server environment:production span.duration:>5s !transaction:["POST /api/v1/conversations/:id/messages","POST /api/v1/conversations/:id/regenerate"]`
- Visualize: `count()`
- Display: Bar chart，Interval 1d

> 基线：10-14 有 1752 次、10-18 有 4280 次，其余日子百位数。**突发型**，与"一阵一阵"吻合。

### 5. 页面可用耗时 p75 / p95（上线后）

- Dataset: `Metrics` → `page.ready.duration`
- Visualize: `p75` 和 `p95`
- Group by: `route`

### 6. 冷启动对比（上线后）—— 回答"刚进去是不是更慢"

- Dataset: `Metrics` → `page.ready.duration`
- Visualize: `p95`
- Group by: `cold_start`

### 7. 大厅缓存 vs 真实数据（上线后）

同一张图放两个 series，均过滤 `route:/`：

- `p75(page.ready.duration)` —— 用户看到列表的时刻（含本地缓存秒开）
- `p75(page.data_fresh.duration)` —— 最新数据到达的时刻

> 两条线差距大 = 用户看到的是旧数据，后端其实很慢。

### 8. 卡住事件（上线后）

- Dataset: `Issues`
- Query: `is:unresolved perf_event:page_stall`，另建一个 `perf_event:action_stall`
- Display: Table，列出 issue、events、users

---

## 看板二：服务端与稳定性

### 9. 接口耗时：前端视角 vs 后端视角（上线后）

同图两个 series：

- `p95(api.request.duration)`（Metrics，过滤 `outcome:ok`）
- `p95(http.server.duration)`（Metrics，过滤 `kind:standard`）

> 前端明显高于后端 = 慢在网络、Vercel 代理或排队，不在后端处理。

### 10. 请求结果分布（上线后）

- Dataset: `Metrics` → `api.request.duration`
- Visualize: `count()`
- Group by: `outcome`（ok / http_4xx / http_5xx / timeout / network）
- Display: Area chart

### 11. 数据库等待与连接池（上线后）

- Dataset: `Metrics` → `db.client.operation.duration`
- Visualize: `p95`，Group by `model`
- 另建一张：Visualize `count()`，Query `outcome:pool_timeout`

> 这是 15 秒 500 和偶发卡顿的直接证据，见 `research/slow-500-findings.md`。

### 12. 运行时与资源（上线后）

- `runtime.event_loop_delay_p99`（gauge，Line chart）
- `asset.load_failed`（count，Group by `kind`）
- `perf.instrument_error`（count）—— **应长期为 0**，不为 0 说明监控自身在失效

---

## 建完之后

1. 把两个看板加到 Sentry 侧边栏的 Starred Dashboards，方便每天看。
2. 阈值告警等基线稳定后再配（T9 飞书）。当前只有图表，没有告警。
3. 第 1、2 张图的基线数字已经说明：**首屏本身就慢，不只是偶发**。这是独立于"偶发卡顿"的另一个问题，值得单独排期。
