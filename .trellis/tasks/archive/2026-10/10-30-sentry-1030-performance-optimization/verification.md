# 验证记录

## 自动化结果

- `pnpm -r typecheck`：通过，覆盖 shared、backend、ui-tests、reply-renderer、frontend、admin。
- `pnpm --filter @miniapp/frontend lint`：通过；只有仓库既有的 `@next/next/no-img-element` warning。
- `pnpm --filter @miniapp/frontend test`：通过，64 files / 683 tests。
- `pnpm --filter @miniapp/backend test -- --exclude '**/*.integration.test.ts'`：通过，110 files / 1128 tests。
- 前端定向请求与短剧测试：通过，4 files / 23 tests。
- 后端 `generate-postprocess.test.ts`：通过，3 tests；异步诊断断言使用 `waitFor`。
- 后端 `conversations-thinking.test.ts`：隔离串行复跑通过，21 tests。此前与两个 typecheck 并发时发生一次转换资源超时，不是断言失败。
- `pnpm --filter @miniapp/frontend build`：通过。构建产物中 `/` First Load JS 272 kB（10-29 任务记录基线约 288 kB），`/characters` 256 kB，`/dramas/[id]` 270 kB，`/create` 243 kB，`/create/studio/[conversationId]` 271 kB，共享 192 kB。
- `pnpm --filter @miniapp/backend build`：包没有 `build` script；backend 已由 typecheck 和全量测试覆盖。

## 固定 UI 场景

- `@profile`：12/12 通过，覆盖 390px 与 320px、余额/签到/VIP/充值等流程。
- `@roleplay`：首轮 10/12 通过。两项失败分别为 Android 首次聊天动态路由未在断言窗口完成，以及一次 fixture 状态请求 `ECONNRESET`；对应 narrow 用例通过。
- Android roleplay 单独复跑仍在首次导航处超时。trace 证据：会话详情接口 31 ms、HTTP 200、响应完整；首个 Next RSC 路由请求 11.29 s 后因热更新中止，随后同路由请求 52 ms。失败属于本地开发态首次编译/热更新窗口，不是会话 API 慢响应。
- 完整 `@drama` 运行超过 5 分钟工具时限，不能记为完整通过。随后定向运行“剧场进入选集”和“长选集定位”共 4 项：3/4 通过；长选集两种尺寸均通过，基础流程 narrow 通过。唯一 Android 失败发生在进入短剧详情的首次动态路由阶段，尚未到达选集交互。

## 构建环境说明

- 首次 frontend build 暴露本地 pnpm 包内容缺失（Next `dist/build/webpack-build/impl`）；`pnpm install --force --frozen-lockfile` 从本地 store 恢复后构建通过，未修改 lockfile。
- 没有真实 Telegram、LLM 供应商、生产数据库或生产流量联调。本地结果不能证明线上 P95 已下降；发布后必须用同一统计窗口复核 Sentry/Grafana。

## 发布后观测与停止条件

- 对比 `/characters`、`/profile`、`/dramas/:id`、`/create/studio/:conversationId` 的 navigation/page-load P95 与样本量。
- 对比 messages/regenerate 的首字耗时与完整 SSE handler 耗时，不能用完整生成时长替代首字体验。
- 关注 `conversation.rich_reply.diagnosis_failed`、首字 deadline、session ownership、`api.request_failed` 与外部 `internal_error`。
- 若聊天首字失败率、身份映射异常或富文本降级明显增加，优先回退并行准备或异步诊断；若选集首次打开失败，则回退动态加载。
