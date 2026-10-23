# Implement: 图片广场分享自动打标签

## 执行顺序

1. **Backend tagging helper**  
   `features/image-plaza/tagging.ts`：读 `getImageRuntimeConfig().textModel`，提示词分类，sanitize 到启用 id，超时参数可测。
2. **Repository**  
   `loadSharePrompt(artifactId,userId)`（从 attempt 取 prompt）；`updateWorkTagsIfEmpty(workId,userId,tags)`。
3. **Route**  
   改造 `POST /api/image-plaza/share`：客户端非空直分享；空则 2s race + 异步补标。
4. **Tests**  
   tagging sanitize + share 路由/编排单测（mock 文本模型与 repository）。
5. **验证命令**
   ```bash
   pnpm --filter @miniapp/backend exec vitest run src/features/image-plaza src/routes/image-plaza
   pnpm --filter @miniapp/backend typecheck
   ```
6. **人工**  
   本地分享一张图（tags=[]）；人为拖慢模型验证超时先分享再补标；传手动 tags 确认不调模型。

## 失败路径覆盖

- 文本模型未配置 / HTTP 非 2xx / 非 JSON → 空 tags，分享成功。
- 返回未知 id → 丢弃。
- 异步补标时 works 已有 tags → no-op。
- already_shared → 不补标、不改 tags（保持首次分享快照）。

## 不做

- Frontend 选标 UI、migration、generation `execute` 计费链路。
