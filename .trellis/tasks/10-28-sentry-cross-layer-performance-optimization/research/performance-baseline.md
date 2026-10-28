# 2026-10-28 性能基线

## 观察窗口

- Sentry：2026-10-27 15:00 至 2026-10-28 14:28，Asia/Shanghai。
- 报告：`D:/JobExe/ST/sentry/2026-10/2026-10-28  3点后至今.md`。
- Railway：production `stminiapp`，单 replica，`asia-southeast1`。
- Supabase：Production，Postgres 17，`ap-southeast-1`；仅只读采集。

## 用户可见 P95

| 页面/动作       |   P95 |
| --------------- | ----: |
| Chat navigation | 9.39s |
| Home navigation | 6.27s |
| Home pageload   | 9.67s |
| Profile         | 5.23s |
| Create          | 5.09s |
| Characters      | 4.59s |
| Dramas          | 4.37s |
| Drama detail    | 3.86s |

## Backend 与外部链路

- messages 完整 SSE P95 46.25s，regenerate 63.81s；不能解释为首 token 延迟。
- image plaza feed P95 3.24s；text postprocess versions P95 3.22s；多数普通读取小于 1 秒。
- http.client internal_error 235：OpenRouter 125、Venice 75、MiniApp 内部 20、Supabase 15。
- 生成 attempt：OpenRouter TTFT P95 3.665s，Venice 4.749s。
- 最新 first-token release 后初样本：send 53、regenerate 3；send client-visible P95 约 7.2s，delivery failure 0。样本不足，需满 24 小时。

## Railway

- CPU 平均约 0.038、峰值约 0.167；内存平均约 0.27GB、峰值约 0.62GB。
- 没有 CPU/RAM 饱和证据；扩 replica 不是首要方案。
- 当前单 replica，任何 L1 cache/single-flight 都是本地优化，不得成为权威状态。

## Supabase

- 连接 20/60，active 1、idle 19、idle in transaction 0；无连接耗尽证据。
- 热 PostgREST P95 多数低于 0.5s；`current_chat_history` 存在约 8.35s 最大尾延迟。
- 图片 feed 数据库边缘 P95 约 0.46s，明显低于 Backend 3.24s，优先排查 hydrate、签名和应用处理。
- `runtime_config` 单次均值低，但调用量高，适合请求级快照/短缓存，不适合提高连接池。
- 累计长 analytics 查询均值约 133s，属于后台 I/O 风险，不是页面直接链路。
- advisor 存在 unindexed FK/unused index，但不得按 advisor 批量执行。

## 可观测性缺口

- Errors 552、Logs 139134、Spans 753023 被丢弃。
- Error dataset 为 0 不能证明无错误；Railway 仍出现 sync-job generation error、AbortError 和 stream started then failed。
- drama repository 抛通用错误，丢失 PostgREST cause；必须先修复错误分类。

## 决策

1. P0：观测可信度、导航 epoch/取消/重试、戏剧首屏和遥测隔离。
2. P1：图片 feed、文本版本、Characters/Profile/Chat 次要请求。
3. Gate：first-token 满 24 小时后再决定生成重构。
4. P2：只有生产计划证据通过时才做索引/RPC/查询结构变化。
