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

## Failure-path checks

- 400/422/429/timeout 的既有 disposition 不变化；queue 不自动重试。
- 已终态 attempt 不请求详情；pending/queued/processing 仍轮询且后台暂停、前台恢复。
- config/conversation 失败仍保留现有重试 UI；dynamic chunk 不阻塞主页面。
- 空模型目录、超长模型说明、无参考图的 required model 仍按现有逻辑处理。

## Commands

```powershell
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/backend test -- video-upstream.test.ts
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/backend typecheck
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/frontend typecheck
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/frontend test
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/frontend lint
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' --filter @miniapp/frontend build
& 'D:\nvm\nvm\v22.14.0\node.exe' 'D:\node\node_modules\node_modules\pnpm\bin\pnpm.cjs' test:ui --grep @image
git diff --check
```

真实 Venice canary 会产生费用且已失败 attempt 不应自动重投；只在用户已有显式测试操作或后续授权下，通过 PR-566 手动验证。
