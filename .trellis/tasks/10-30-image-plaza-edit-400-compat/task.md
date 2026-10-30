# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                         | Files / Scope                                                | Depends On | Verification          |
| --- | ------ | -------------------------------------------- | ------------------------------------------------------------ | ---------- | --------------------- |
| T1  | Done   | 按模型 sizing mode 组装 Venice edit 尺寸字段 | `packages/backend/src/features/image-plaza/upstream.ts`      | -          | 定向 upstream 单测    |
| T2  | Done   | 把 worker 失败安全摘要写入现有 Sentry Logs   | `packages/backend/src/features/image-plaza/job.ts`           | T1         | typecheck、代码审查   |
| T3  | Done   | 增加固定尺寸与分辨率编辑请求回归覆盖         | `packages/backend/src/features/image-plaza/upstream.test.ts` | T1         | 定向 Vitest           |
| T4  | Done   | 执行全量 Backend 验证并检查 diff/spec        | Backend + Trellis task artifacts                             | T1-T3      | typecheck、test、lint |

## Execution Log

- 2026-10-30：完成 Railway/Sentry/源码/Venice 当前模型契约只读调研；进入规划，尚未修改产品代码。
- 2026-10-30：完成 Venice edit 兼容修复：`aspect_ratio`/`pixels` 模式不再把内部 `fixed` 占位发送为 `resolution: "1K"`，`resolution` 模式继续发送真实 `1K`/`2K` 档位；未改变超时、单次调用、attempt 终态或结算语义。
- 2026-10-30：worker 在原有 `markFailed` 尝试和 Pino 日志后，通过现有 `sendBackendSentryLog` 写 attempt/model/mode/errorCode/outcomeUnknown 脱敏摘要；同步 SDK 异常被隔离，不包含 prompt、参考图、响应正文或 URL。
- 2026-10-30：定向 `upstream.test.ts` 通过（1 file / 11 tests），其中真实故障组合 `seedream-v5-lite-edit + i2i + aspect_ratio + fixed` 精确断言无 `resolution`，已有 `resolution + 2K` 用例继续通过，429 用例确认 fetch 仅调用一次。
- 2026-10-30：Backend typecheck 通过；完整 Backend 测试首次出现未改动 `generation/execute.test.ts` 的计时竞争抖动（1/1066 失败），该文件单独重跑 70/70 通过，随后完整重跑 108 files / 1066 tests 全部通过。
- 2026-10-30：改动文件 Prettier、改动 TypeScript 的等价 ESLint import 检查、`pnpm lint:legacy` 与 `git diff --check` 通过。根 `pnpm lint:imports` 在 Windows 因脚本 `--rule '{}'` 被解析为字符串而退出 2，未作为代码失败；未调用真实 Venice、Railway 或 Sentry，也未执行部署。
- 2026-10-30：独立检查补充既有 `settlement.test.ts`：精确断言 worker 只向 Sentry 发送 attempt/model/mode/errorCode/outcomeUnknown 白名单摘要，并验证 Sentry helper 同步抛错时 attempt 仍先落为 `failed`；图片广场定向 2 files / 37 tests 通过。
- 2026-10-30：检查阶段 Backend typecheck、改动文件 ESLint、legacy guard、Prettier 与 `git diff --check` 通过。完整 Backend 测试首轮出现未改动 `generate.lifecycle.test.ts` 的 5000/5001ms 计时抖动（1/1067 失败），该文件单独复跑 28/28 通过，随后完整重跑 108 files / 1067 tests 全部通过。
- 2026-10-30：补齐两个已声明模块的 `module-updates.json`；`module_knowledge.py check` 在确定性重建索引后通过。Windows `core.autocrlf=true` 使两个未变更索引仅发生 LF/CRLF 工作区差异，检查后恢复其原始行尾，未把无关索引混入任务 diff。
