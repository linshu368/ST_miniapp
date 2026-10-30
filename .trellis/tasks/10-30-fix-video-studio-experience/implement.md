# Implementation Plan

## Phase A — Provider contract fix

- 修改 `video-upstream.ts`，只在 Venice queue payload 边界把秒数格式化为 `<n>s`。
- 更新已有 upstream 测试，断言 duration、resolution、aspect_ratio、audio 与 image/reference 字段。
- 不改变 queue retry、错误分类、退款或数据库状态机。

## Phase B — Studio loading performance

- conversation 成功响应同步填充 video-attempt query cache。
- terminal video attempt cache 使用无限 stale；非终态继续立即读取和退避轮询。
- studio 线性预计算每条 assistant message 最近的 user prompt。
- 图片设置、视频模型、视频设置组件改为 dynamic import，并仅在对应 open 状态挂载。

## Phase C — UI resilience

- Header 左侧设 `flex-1 min-w-0`，两侧操作按钮/容器 `shrink-0`；标题容器独立截断。
- VideoModelSheet 使用明确 padding、gap、safe-area、overscroll、focus-visible 和长文本处理。

## Phase D — Deployed 400 follow-up

- 保留 `duration: "<n>s"`；`audio=true` 依赖 Venice 默认值并省略，`audio=false` 才显式发送。
- 非 2xx 只解析 provider error type、脱敏短消息和 validation field paths，写入现有 `{ err }` 日志。
- retrieve 接收 provider timing，下一次 poll 使用 5–10 秒有界建议；缺失/非法 timing 走同样封顶的 fallback。

## Phase E — End-to-end visible latency

- attempt 创建保留 user/assistant message 顺序写入以稳定历史顺序，并返回两者服务端引用；attempt/artifact 读取并行。
- submit 响应新增可选 `message_refs`，Frontend 立即 append 两条 server-id message，并兼容旧响应 invalidate。
- 非终态 video attempt 作为视频状态唯一轮询源，按 submitting/pending 3 秒、queued/processing 5 秒、storing 2 秒读取；每次结果合并回 conversation cache，保留图片 attempt 的既有 conversation 轮询。
- API 受理后 wake worker，忙时仅补跑一次；视频与 poster 并发上传并用 `allSettled` 等待完成后再进入失败清理。
- queued/ready/failed 增加安全参数摘要与阶段/总耗时。

## Failure-path checks

- 400/422/429/timeout 的既有 disposition 不变化；queue 不自动重试。
- upstream error body 解析失败时仍按 status 分类；错误摘要不得包含 URL、data URL 或 prompt。
- worker wake 不改变 DB lease/fencing；多次 wake 合并，关闭 worker 后为 no-op。
- `message_refs` 缺失、重复 onSuccess 或 conversation 已包含 attempt 时不插入重复消息。
- 已终态 attempt 不请求详情；pending/queued/processing 仍轮询且后台暂停、前台恢复。
- config/conversation 失败仍保留现有重试 UI；dynamic chunk 不阻塞主页面。
- 空模型目录、超长模型说明、无参考图的 required model 仍按现有逻辑处理。

## Commands

```powershell
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/backend test -- video-upstream.test.ts
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/shared test
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/shared typecheck
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/backend typecheck
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/frontend typecheck
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/frontend test
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/frontend lint
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/frontend build
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' -r typecheck
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/ui-tests exec playwright test --grep "@image"
git diff --check
```

真实 Venice canary 会产生费用且已失败 attempt 不应自动重投；只在用户已有显式测试操作或后续授权下，通过 PR-566 手动验证。

## Phase F - Six-model compatibility and regeneration fidelity

- Compare the six enabled products and their ten provider-mode IDs with the current Venice video catalog; record valid subsets and mismatches without storing provider responses or secrets.
- At the Venice adapter boundary, omit `aspect_ratio` for I2V while preserving it for T2V and R2V.
- Add a pure frontend helper that derives a quote request from `VideoPlazaAttempt.params`; use it for video-card regeneration and submit the original reference artifact.
- Reject regeneration when the historical model or mode is no longer enabled rather than substituting the current composer model.
- Extend existing test files only. Run backend upstream tests, frontend media/API tests, affected package typechecks, frontend lint/build, workspace typecheck, `@image`, and `git diff --check`.

Failure paths: a missing/disabled historical model shows an actionable error; a missing required historical reference is rejected by the existing quote/submit validation; quote failure does not create or bill an attempt; provider queue remains non-retried.

## Verification Results

- Six-model audit: all ten configured provider-mode IDs exist in Venice's current public catalog. Product duration, resolution, T2V/R2V ratio, and audio settings are valid subsets.
- Targeted backend upstream tests: 7/7 passed. Targeted frontend media-cache tests: 26/26 passed. Backend full tests: 1141/1141 passed.
- Frontend full run passed 654 business assertions; the existing artifact-renderer suite timed out once in its esbuild hook under parallel load and then passed 2/2 in isolation.
- Frontend lint, production build, Admin production build, and workspace typecheck passed. Lint retains only existing `<img>` warnings.
- `@image`: 7/8 passed in the full run, including the narrow reuse scenario and video-work reuse. The Android reuse case failed once before navigation and its isolated retry timed out during `page.goto`; this is recorded as local preview-server instability rather than a studio assertion failure.
- No paid Venice canary, deployment, Admin publish, commit, or push was performed.

- Shared 全量：18 files、200 tests 通过；新增 video submit additive contract 覆盖通过。
- Backend 全量：113 files、1140 tests 通过；upstream 定向 6/6 通过。
- Frontend 全量：64 files、655 tests 通过；media cache 定向 25/25 通过。
- `pnpm -r typecheck`、Frontend lint、Frontend production build 通过；lint 仅保留仓库既有 `<img>` warning。
- `@image` 本地移动端验收 8/8 通过；`git diff --check` 通过。
- 未自动部署、未触发真实 Venice 付费 canary；PR-566 上线后的 MiniMax H3 Max 10s/1080P/t2v 仍需显式生成确认。
