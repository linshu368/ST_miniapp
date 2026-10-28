# 连接池调查（2026-10-21，只读）

范围：production。方法：Sentry 查询、Railway CLI（只读取 `DATABASE_URL` 的端口与查询参数名/值，未读凭据）、Supabase MCP 只读 SQL（`pg_stat_activity` 聚合）。未改任何配置和代码。

## 事实

- Sentry：连接池超时报错 14 天共 3012 条，其中 2026-10-18 一天 2701 条；最后一条 2026-10-18T16:21Z，此后 0 条。报错文本里的配置是 `connection limit: 5, pool timeout: 10`。
- Railway production 现在的 `DATABASE_URL` / `PROD_DATABASE_URL`：端口 6543（Supavisor），查询参数 `pgbouncer=true&connection_limit=10&pool_timeout=10`。**即 limit 已从 5 提到 10。**
- 仓库里没有这个参数的记录（`git log -S connection_limit` 仅命中无关提交；`.railway/railway.ts` 用 `preserve()`，值只存在 Railway 控制台）。无法确认谁在何时改的；最近一次生产部署序列在 2026-10-19 09:20 (+08:00) 之后，与报错消失时间吻合，但这只是时间上的吻合。
- 数据库侧（某一时刻快照）：`max_connections=60`，已用 51（Storage 约 17、Supavisor 约 13、PostgREST 8、其余为内部），活跃 3，`idle in transaction` 0。余量很薄。

## 结论

1. 池超时这条根因**已被配置变更缓解**，本任务不再改配置。
2. 之前我写的"仓库里没配 `connection_limit`"不准确——配在 Railway 控制台里，不在仓库里。
3. 问题没有完全消失：
   - 2026-10-20 仍有 104 个 5 秒以上的非对话请求。
   - 2026-10-20 11:34:56Z 同一秒内约 20 个 `GET /api/characters/:id` 耗时 7–14 秒且返回 200，每个都只有一个约 7 秒的 DB span，其余 DB span 为毫秒级。符合"短时间内整体卡住"，原因未证实（可能是池排队，也可能是 Supavisor/数据库瞬时停顿）。
   - `GET /api/characters` 在 2026-10-20 07:16–07:17Z 与 2026-10-21 06:05Z 出现约 15.03 秒的 500，**没有对应的 Sentry 错误事件**。这是一个固定的 15 秒超时，来源未知。
4. 数据库连接余量薄：继续上调 `connection_limit` 或增加副本前，要先核实 Supavisor 池大小与副本数，否则可能把 60 个连接占满。

## 交工程的事项（代码层）

- `GET /api/characters/:id` 一个请求并发 4 个查询，其中 `prisma.character.findMany` 每次拉全部上架角色的 id 只为判断金框（`packages/backend/src/routes/characters.ts` 约 165–176 行）；大厅排序快照与固定位也每次现读。可考虑进程内短 TTL 缓存或只取判断所需的最小数据，降低每请求连接占用。
- 调查上面 15 秒 500 的来源（Fastify/Railway/Prisma/上游的哪一层，为什么没进 Sentry）。
- 把 `connection_limit` / `pool_timeout` 的当前值与调整理由写进 `ops/railway/README.md`，避免只存在控制台。
- 核实 Railway 副本数与 Supavisor 池大小，再决定 limit 是否继续调整。

本任务的监控（design.md §5）会给这几项提供证据：`db.client.operation.duration`、事件循环延迟、按路由的 p95/p99。
