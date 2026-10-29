# 实施计划

## 0. 开始门禁

1. 人工审核 `prd.md`、`design.md`、`implement.md`、`task.md`。
2. 运行 `task.py validate`，审核后执行 `task.py start`；此前不写产品代码。
3. 保留当前 dirty worktree，逐文件检查 staged/unstaged 差异，不覆盖其他任务修改。

## 1. 请求取消与重试

1. QueryClient 默认 query retry 改为 false；API Client 的一次 GET transport retry 保持权威。
2. 退避等待接收 AbortSignal；排队/退避/fetch 任一阶段 abort 都立即终止。
3. characters、conversations、support queryFn 传 signal。
4. lobby Next route 合并入站取消与 5 秒 timeout。
5. 扩展现有 `client.retry.test.ts` 与 `lobby-characters/route.test.ts`，覆盖最多两次、abort 不重试、upstream timeout/signal。

## 2. Characters

1. Gallery 计算 recent session 并从当前 character list 取摘要。
2. RecentConversationCard 改为纯展示/重试回调，不自行 query。
3. 删除追加 preload/preconnect 的 effect。
4. CharacterDetailSheet 动态导入并条件挂载。
5. 运行 `@roleplay`，核对请求摘要只有一条 conversations list 且无 recent character detail。

## 3. Chat

1. 动态导入 CharacterDetailSheet 与 ChatSessionDrawer，条件挂载。
2. 构建并记录 route size；若独占 >90 kB，再拆非首屏 image/voice footer。
3. 运行 chat session、conversation stream、first-token/fallback/cancel/billing 既有测试与 `@chat`。

## 4. 首页

1. 将 comments context/owner 与完整 comment sheet 分离；sheet 首次打开才下载。
2. 不改变 DramaPlayer/playback/detail/social 调度。
3. 运行 drama tests、`@drama`，构建确认 `/` 首载不回退。

## 5. Support

1. unread query 使用 signal，并仅在 stale 时 mount refetch；保留轮询/foreground。
2. support route 补齐所有 `@frontend-ready` 注释。
3. proxy helper 记录 identity/upstream/total/status；异常 `{ err }` 后抛出。
4. 扩展现有 support proxy test，验证透传、日志安全字段与错误路径。

## 6. 验证命令

```powershell
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test -- src/lib/api/client.retry.test.ts src/app/api/lobby-characters/route.test.ts src/hooks/use-chat-session.test.ts
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test -- src/routes/support-cs-proxy.test.ts src/features/conversations/generate.test.ts src/features/conversations/generate.lifecycle.test.ts
pnpm --filter @miniapp/backend test
pnpm test:ui --grep @roleplay
pnpm test:ui --grep @chat
pnpm test:ui --grep @drama
pnpm test:ui --grep @profile
git diff --check
```

失败路径必须覆盖：排队取消、退避取消、在途取消、lobby timeout、Recent card query error/retry、dynamic panel 首开、support upstream throw、chat first-token/fallback/cancel/billing。

## 7. 收尾与自动归档

1. 写 `implementation.md`、`verification.md`，记录 route size、请求计数、失败路径和本地边界。
2. 更新受影响 module spec 的当前状态/验证时间与 `module-updates.json`。
3. `task.py validate`；所有必需检查通过后执行：

```powershell
python ./.trellis/scripts/task.py archive --no-commit optimize-sentry-slow-pages-apis
```

4. 不自动 commit、amend 或 push；归档只移动 Trellis 任务目录。
