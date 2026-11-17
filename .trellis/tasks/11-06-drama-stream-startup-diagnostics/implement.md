# 执行计划

1. shared schema：`kind`、`hls`；shared 测试。
2. 后端写入条件；`engineering-observability.test.ts` 补实验组快样本用例。
3. `drama-stream-origin.ts` + `layout.tsx` + `startDramaPlayIntent`。
4. `drama-resources.ts` 的 Stream 匹配与 `kind`；`drama-media.test.ts` 补用例（kind、非 Stream 仍精确匹配、上报不含 URL）。
5. `drama-hls.ts` + `loadDramaSource` 的 `onHls` + `hlsTiming` + 播放器接线；新增 `drama-hls.test.ts`（字段映射、16 条上限、终态后停止、不含 URL），`drama-media-source.test.ts` 补 `onHls` 调用顺序。
6. 文档：`docs/ARCHITECTURE.md` Vercel 变量、`drama-experience.md`。

## 验证命令

```
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend exec vitest run src/lib/engineering-observability.test.ts
pnpm --filter @miniapp/frontend exec vitest run src/lib/perf src/lib/drama-media-source.test.ts
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
pnpm lint:complexity
pnpm --filter @miniapp/frontend build
```

## 失败路径与人工核验

- 变量缺失/非法：不输出 preconnect（单测覆盖解析）。
- PerformanceObserver 不支持：维持 `unsupported`（既有用例）。
- hls.js 事件数据缺字段（如 `frag.sn === 'initSegment'`、`stats.loading.first` 为 0）：字段省略，不写 0。
- 上线后人工核验：Loki 中 Stream 组快样本出现；iOS 记录有 `kind`；Android 有 `diagnostics.hls`；记录中无 `cloudflarestream.com/` 后接签名的串。
