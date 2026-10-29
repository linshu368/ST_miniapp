# CDN 调研与决策依据

## Supabase Storage

- Storage 资源经 CDN 分发；public bucket 通常比 private signed URL 具有更好的缓存命中。
- public image transformations 支持宽高、resize、quality，并自动选择 WebP；属于 Pro 及以上能力，实施前确认配额和计费。
- Smart CDN 对变更/删除对象的边缘失效可能需要约 60 秒，浏览器缓存 TTL 独立；频繁替换内容应使用版本化路径或查询版本。
- private signed URL 的不同 token 会形成不同 cache key；复用同一有效 signed URL 有利于命中。现有后端短期缓存/single-flight 应保留，但不得持久化到浏览器目录缓存。

官方资料：

- https://supabase.com/docs/guides/storage/cdn/fundamentals
- https://supabase.com/docs/guides/storage/cdn/smart-cdn
- https://supabase.com/docs/guides/storage/serving/image-transformations
- https://supabase.com/changelog?types=breaking-change

截至 2026-10-29，未发现阻止本方案的 Storage CDN/Image Transformations breaking change；仍需在实施时复核配额和项目 plan。

## Bunny

- Bunny 不会自动识别 origin 文件变更；内容在 TTL 到期或 purge 前可能继续缓存。
- 没有自动 cache warming，应通过真实流量/受控预热和 HIT/MISS 证据评估，不能假设全量上线即命中。
- 当前仓库 zone/runbook 面向 TEST 私有视频；生产必须建立独立 namespace/rule/token 和显式回滚开关。

官方资料：https://bunny.net/faq/

## 决策

1. public 图片优先 Supabase transform + Smart CDN，有限 variants 提升命中；不迁入 Bunny。
2. private 视频只在 TEST A/B 证明 first-frame/Range/stall 收益后推进 Bunny 生产灰度。
3. 目录数据用客户端版本化缓存解决打开等待；不把用户相关 API 响应错误设为 shared CDN cache。
