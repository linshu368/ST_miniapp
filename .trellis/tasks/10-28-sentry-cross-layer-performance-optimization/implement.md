# 实施计划

## 0. 开始门禁

- 人工审核 `prd.md`、`design.md`、`implement.md`、`task.md`。
- 以最新 main 为基线，记录 Railway release 与本地 commit；任务状态仍为 planning 时禁止写产品代码。
- 重新采集固定 Sentry 查询、Railway CPU/RSS/event-loop/重启和 Supabase 连接/热查询基线。

## 1. Batch A：观测与导航调度

1. 扩展阶段指标，保留 drama Supabase error cause。
2. 引入 route epoch、取消传播、critical 槽位和 telemetry background 预算。
3. 删除双层重试，统一总预算和错误分类。
4. 验证旧路由取消、弱网、abort、401/429/5xx 和重试停止条件。

验证：

```bash
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
```

## 2. Batch B：戏剧首屏与遥测

1. 并行 play/目录，调整请求优先级和首帧后的加载顺序。
2. telemetry 改为验证后 202 + 有界异步处理，记录 accepted/dropped/persisted。
3. 根据真实 error cause 清零 drama 5xx；只有证据通过才增加 bounded SWR。
4. 扩展现有 drama UI fixture，覆盖成功、慢 play、目录失败、telemetry 过载和首帧失败。

验证：Frontend/Backend 全套命令；`pnpm test:ui --grep @drama`（若现有标签不同，按 `packages/ui-tests/README.md` 使用实际分组）；Telegram WebView 首帧 smoke。

## 3. Batch C：页面分波与媒体资源

1. Characters/Profile/Chat 合并重复订阅和次要请求。
2. 图片 feed 显式投影、批量签名、短缓存和失败清理。
3. Frontend prefetch、响应式图片、动态加载和列表窗口化。
4. Text postprocess LRU/inflight/miss 批读。

验证：Frontend/Backend 相关测试与构建；`@profile`、`@chat`、`@image` UI 分组；签名调用计数、响应体大小和 warm/miss 指标。

## 4. Gate D：生成链路 24 小时决策

记录观察时长、样本数、server-ready、client-visible、ready-to-visible、fallback、delivery failure、扣费/额度异常。指标已达标则将 T7 标记 Skipped 并记录停止理由。

未达标时：

1. 实施请求级 GenerationConfigSnapshot，先只消除同请求重复读取。
2. 在低风险展示配置上启用短 SWR；计费事实 fail-closed。
3. 引入可关闭的 provider/model 断路器。
4. 通过明确终态返回值消除成功流重复持久化，保留所有 pre-stream 收口。

验证：现有 generation、billing、cancel、fallback、recoverable delivery 测试；shared tests/消费者 typecheck（如契约变化）；真实 SSE smoke，不做真实扣款写入。

## 5. Gate E：数据库证据与可选 migration

- TEST 与 Production 分别核对 schema、索引、ACL/RLS、行数和计划。
- 受控执行候选查询的 `EXPLAIN (ANALYZE, BUFFERS)`；生产 PostgREST `.explain()` 不作为默认入口。
- 只有计划和收益门禁通过后，创建一个独立 migration，记录 lock/statement timeout、磁盘容量、失败恢复和 drop/forward-fix。
- migration 只手工执行一个文件；先 TEST，生产需另行授权。

## 6. 发布与复核

- 每批独立 PR/commit；不把 schema、provider routing 和导航调度混合。
- 发布后检查 2 小时早期停止条件，24 小时确认 P95 与错误率。
- 完成所有 consumer 验证、模块知识更新和 release-review 后才能归档。

## 回归测试文件决策

优先扩展已有测试文件。导航取消/重试、generation 终态/计费 CAS、telemetry 过载属于并发和计费风险，规划审核时应确认必须有自动回归覆盖；普通动态加载和图片 priority 不单独新增测试文件，但必须运行现有 UI 流程和人工验收。
