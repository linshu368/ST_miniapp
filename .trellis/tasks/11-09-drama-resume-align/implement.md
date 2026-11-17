# 执行计划

1. `drama-media-source.ts`：新增 `STREAM_HLS_FRAGMENT_SECONDS` 常量、`alignResumeSeconds`、`resolveResumeTarget` 两个纯函数；`loadDramaSource` 增加可选第 6 参数 `options?: { startPosition?: number }`，写入 `new Hls({ startPosition })`。
2. `drama-player.tsx`：在媒体加载 effect 里（checkpoint 分支之后、调用 `loadDramaSource` 之前）用 `resume`/`resumePending`/`resumeExactPosition` 算出 `startPosition` 并存入新 ref，作为 `loadDramaSource` 第 6 参数传入；`onLoadedMetadata` 改用 `resolveResumeTarget` 统一计算目标秒数，命中"hls.js 已处理同一目标值"时跳过重复 `currentTime` 赋值。
3. `drama-home.tsx`、`dramas/[id]/page.tsx`：`preloadDramaHls()` 的调用改为等待 `afterNavigationQuietWindow()` 后再触发，effect cleanup 置 `cancelled` 防止卸载后调用。
4. 补单测：`drama-media-source.test.ts` 新增 `alignResumeSeconds`/`resolveResumeTarget` 边界用例，以及 `loadDramaSource` 带 `startPosition` 时写入 `Hls` 配置的用例。
5. 运行验证命令（见下），确认 typecheck/测试/lint/complexity 通过。
6. 收尾：把结果和发布后验证方法告知用户，不自动提交、不自动合并、不自动推送。

## 验证命令

```bash
pnpm --filter @miniapp/frontend exec vitest run src/lib/drama-media-source.test.ts
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm lint:complexity
git diff --check
```

## 回滚点

- 三处改动互相独立：`drama-media-source.ts` 的纯函数、`drama-player.tsx` 的续播接线、两个预加载调用点，可单独回退任意一处。
- 不涉及 Backend、shared 契约、数据库或环境变量，Frontend 单独发布即可回滚。

## 发布后验证

按 prd.md「发布后验证方法」，用新版本 `app_version`/`context.release` 过滤 `drama.startup_diagnostic`，对比续播样本 `metadata_to_data`、首片 `hls.entries[0].sn` 是否命中目标分片、会话首播 `source_set`→`manifest.startMs`；Android direct P95 目标约 5.05s（基线 6.64s，N=28，样本仍偏小，发布后低样本只作方向参考不补零）。
