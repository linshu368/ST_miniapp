# `/api/characters` 15 秒 500 调查（2026-10-21，只读）

范围：production。来源：Sentry trace / span、Supabase 只读 SQL、代码检索。未改任何配置或代码。

## 结论

**15 秒不是某个 HTTP 层的超时，而是单条 Postgres 查询被掐断。** trace `0be2466471c44a49832333136a0928a3`：

```
GET /api/characters            15031ms   500
└─ postgresql (db)             15003ms   ← 唯一耗时来源
   postgresql (db)                20ms
```

请求总耗时 15031ms，其中 15003ms 全在一条 db span 上，其余 span 都是毫秒级。多条 500 的耗时高度集中在 15026–15104ms，说明是一个**固定的 15 秒上限**在起作用，不是随机的慢。

## 这个 15 秒来自哪里（未确定）

已排除的：

- Postgres `statement_timeout` = **120s**（配置文件级），`lock_timeout` = 0，`idle_in_transaction_session_timeout` = 0。
- 角色级覆盖：`anon` 3s、`authenticated` 8s、`authenticator` 120s、`service_role` 无 —— 后端用的连接串没有命中 15s。
- 仓库里搜不到 15 秒的相关常量（只有两处无关：图片广场翻译脚本的 sleep、admin 代理的模型测试超时）。
- Fastify 没有配 `connectionTimeout` / `requestTimeout`。
- `next.config.mjs` / `vercel.json` 没有 `maxDuration`。

**剩下最可能的是 Supavisor（Supabase 连接池，端口 6543）的 client/query 超时**，这一条我无法从只读侧确认，需要看 Supabase 控制台的 pooler 配置。

## 为什么 Sentry 里没有错误事件

这些 500 在 span 上是 `span.status: internal_error`，但**没有对应的 error 事件**。查询被中断时的错误很可能被路由里的某段捕获后直接返回 500，没有走 `captureBackendException`。所以"Sentry 错误数为 0"并不等于"没有故障"——这正是本任务要补的盲区。

## 另外两条更严重的发现

同一查询里出现了 **299975ms（约 5 分钟）** 和 **85580ms** 的 `GET /api/characters`，且 `http.status_code: 200`、`span.status: ok`：

- trace `fdd4e3efe16d499aad87f136fa37cedd`（2026-10-18 06:31）：299975ms
- trace `c12baf20027e4b43b0f90fbbb0be4df5`（2026-10-17 14:01）：299987ms
- trace `da9031889a9848d79a4830191ffee96e`（2026-10-18 02:13）：85580ms

299975/299987ms 紧贴 **300 秒**，像是另一个固定上限（Railway 或 Supavisor 侧）。这些 trace 里**没有 db span**，只有 `http.server` 和两个 hook，说明请求卡在进入业务逻辑之前或之后，不是查询慢。

用户在这种情况下早就退出重进了 —— 这与"偶尔打不开、退出重进就好"完全吻合。

## 查询本身不慢

`pg_stat_statements` 里大厅相关查询：mean 113.5ms / max 2608.5ms（46 次），列表 id 查询 mean 5.8ms / max 756.9ms（232 次）。**说明 15 秒不是查询复杂度造成的，而是等待（连接池排队）或被外部中断。**

## 交工程的事项

1. 查 Supabase Supavisor 的 client/query 超时设置，确认 15 秒是否来自那里。
2. 查 299975ms 那类请求卡在哪一层（无 db span，Railway 或 Supavisor 侧的 300 秒上限）。
3. 让查询中断类错误进入 Sentry：目前这类 500 静默，只能靠 span 发现。
4. `GET /api/characters` 与 `/api/characters/:id` 每请求并发多条查询（详情页 4 条），在连接池紧张时会放大排队，见 `pool-findings.md`。

## 本任务的监控如何覆盖这些

上线后：

- `db.client.operation.duration` 会直接给出这条查询的等待分布，`outcome=pool_timeout` 单列。
- `http.server.duration` 的 `status_class=5xx` 会让这些静默 500 出现在看板上。
- 前端 `slow_request` / `page_stall` 会在用户侧记录同一时刻的体感，并带 Replay。
- 前端 20 秒客户端超时会让 299975ms 这类请求提前结束，用户至少能看到错误提示而不是无限等待。
