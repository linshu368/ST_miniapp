# 图片广场移动性能调研（2026-11-02）

## Production 证据

- `/creation`：Android 3.03s/440，iOS 2.14s/115。
- `/create/studio/:conversationId`：Android 4.96s/130，iOS 1.84s/25；iOS 为低样本。
- Studio 日 P95 在 10/30、10/31 为 10.53s、8.72s，11/01 为 3.46s，尚未稳定低于 3 秒。
- `GET /api/image-plaza/feed` 周内峰值 3.219s，最近 0.418s 仅 5 样本。
- `/create` 和 Grafana Android/iOS 图片广场细分无可见样本。

## 代码证据

- Feed 每页 20 条且页面一次挂载所有已有条目；只有首两图 eager/high，没有平台预算。
- 视频 Feed 已只返回/展示 poster，这是正确边界。
- PlazaCard 和 StudioArtifactCard 直接使用原媒体 URL；仓库已有 `supabase-image.ts` 可复用。
- Studio 每个 ready 视频立即挂带 src 的 `<video preload="metadata">`，历史多时可能产生并发 Range/metadata 请求。
- `/create` page ready/entry settled 基于 Feed 数据，不代表首图已解码；Studio ready 基于 config/conversation/model，不代表媒体可见。
- `prefetchImagePlazaFeed` 已存在但无调用方；`/creation -> /create` Link 禁用 Next 自动 prefetch。
- `image-plaza-return.ts` 依赖 DOM 卡片锚点；冷进入可以渐进，但返回时必须保留已缓存项目挂载以避免恢复回退。

## 结论

采用现有移动 policy + 渐进挂载 + Supabase 有限图片变体 + critical visual + 近视口 video src，可以在不改变业务合同和历史完整性的前提下降低可避免长尾。历史分页、服务端 Feed 改造和全局单播放器不属于本轮最小充分方案。
