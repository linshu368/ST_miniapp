# 执行计划

## 1. 策略与基础复用

1. 扩展 `MobilePerformancePolicy`，增加图片广场列表预算、有限响应式图片规格和 Studio 视频激活 rootMargin。
2. 扩展现有 `mobile-performance.test.ts`，锁定 Android X 归类、三平台预算上界、首图 high 和视频 margin。
3. 继续复用 `supabase-image`，不新增图片代理或 URL 合同。

## 2. 广场页面

1. 加入冷进入渐进挂载；query 条件变化重置，有返回快照时保持已缓存内容可恢复。
2. 合并本地补齐与接口翻页触发顺序，兼容无 IntersectionObserver。
3. 将 PlazaCard 拆为 eager/high 两级，接入响应式图片、转换失败原图回退和错误占位。
4. 聚合首两项 critical visual；首屏结算后再启用标签计数、config 预热和 `markCriticalSettled`，增加有限旁路兜底。

## 3. Studio 媒体

1. StudioArtifactCard 接入响应式图片和转换失败回退，保持所有操作使用原 URL。
2. StudioVideoCard 增加 poster shell、显式播放激活和近视口后绑定 video src；保留原 controls/下载/分享/编辑/重生成。
3. 页面识别初始最新 ready 媒体并接入 critical visual；空/非媒体会话记 absent，最新生成图片指标不变。

## 4. 安全预热

1. `/creation` 复用 `afterEntryBackground`、`canPrefetchInBackground` 和 `prefetchImagePlazaFeed`。
2. 清理 effect/idle 句柄；失败静默，不影响收藏、角色创作或导航。

## 5. 验证

```powershell
pnpm --filter @miniapp/frontend test -- src/lib/mobile-performance.test.ts src/lib/supabase-image.test.ts src/lib/api/image-plaza.test.ts
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm test:ui --grep @image
```

人工检查：搜索/筛选/排序/触底、返回锚点、图片失败占位、原图保存、分享/封面/参考、视频生成后播放/下载/重生成。真实 Android/iOS Telegram、Save-Data/2G 和 production P95 留作发布后验证，不能以 fixture 代替。

## 6. Review 与归档

1. 对照 PRD 检查无 API、计费、生成状态和历史完整性变化。
2. 复核是否产生值得写入 spec 的新模块事实；production 候选参数不提前写成已验证事实。
3. 不自动 commit/push；完成本地验证后按用户既有要求 `archive --no-commit`。
