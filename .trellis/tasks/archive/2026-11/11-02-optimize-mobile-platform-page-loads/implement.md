# 执行计划

## 1. 平台策略与回归锁定

1. 从 `env-tags` 导出规范化平台读取函数，保持现有指标调用兼容。
2. 新增纯 `mobile-performance` 策略，定义 Android/Android X、iOS、default 的列表、图片、首页和路由优先级。
3. 新增策略单元测试，覆盖平台归类、有界预算、首页/短剧/角色优先级与 unknown 回退。该测试是本任务审核后的验收要求，用于锁定分平台核心分支。

## 2. 页面资源调度

1. `CharacterGallery` 使用平台首批/批次/rootMargin；第一张 high、首行第二张 eager/auto；卡片根节点加 content-visibility。
2. `DramasPage` 使用平台预算和图片优先级，保持返回恢复 floor 高于平台预算。
3. `DramaPlayer` 在 embedded 首页增加独立关键海报层，海报加载即记录页面关键视觉，视频 `loadeddata` 后淡出；embedded media 改为 metadata preload，详情页保持 auto。
4. `BottomNav` 用策略重排现有候选目标，继续 P0 后串行预取且最多两个。

## 3. 失败路径与 consumer 校验

- 平台读取异常/unknown：默认策略页面可用。
- 海报缺失/加载失败：占位或视频继续，关键视觉记录 absent/error，不阻塞播放。
- IntersectionObserver 缺失：现有全量兜底仍工作。
- 滚动返回：恢复 floor 不被更小首批截断。
- 业务 consumer：`/characters` 搜索/详情/返回、`/dramas` 筛选/触底/详情返回、首页播放/换剧/纯净模式均复用现有 UI 场景。

## 4. 验证命令

```powershell
pnpm --filter @miniapp/frontend test -- src/lib/mobile-performance.test.ts
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm test:ui --grep "@roleplay|@drama|@navigation|@startup"
```

记录构建前后 `/`、`/characters`、`/dramas` First Load JS。UI 测试使用现有 fixture，不新增临时 mock；真实 Telegram Android/iOS、真实媒体/CDN 和 production P95 作为发布后验证。

## 5. Review 与归档

1. 对照 PRD 检查无 API/状态语义变化、没有不受控预取。
2. 更新 `frontend.business.character-lobby`、`frontend.business.drama-experience`、`frontend.infrastructure.client-ui-foundation` 当前事实。
3. 不自动 commit/push；完成本地实现和验证后按用户要求 `archive --no-commit`。
