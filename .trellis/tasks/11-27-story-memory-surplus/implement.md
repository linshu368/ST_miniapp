# 执行计划（分支 codex/story-memory-surplus）

1. **契约**：`packages/shared/src/api/story-memory.ts`
   - 新字段、删 `preferred_providers`、旧形状兼容（preprocess）、默认值。
   - 在 shared 现有 story-memory 测试里补：v3 原样解析后得到新形状，上限 8000、保底 12 轮等不丢。
2. **调用**：`packages/backend/src/features/generation/story-memory-compress.ts`
   - 走 Surplus，改流式，复用 `createSseTap`；
   - 首字计时、请求号、`max_tokens` 24000、字节上限 1 MiB；
   - 新错误码 `first_output_timeout`。
3. **尝试序列**：`packages/backend/src/features/story-memory/compress-chunk.ts`（+ `text.ts` 的板块切分与主线精简 prompt）
   - 并入 → 主线精简 → 删最早条目；
   - 去掉预精简。
4. **日志**：`worker.ts` 的 `provider` 改为 `surplus`；新字段 `first_output_ms`、`reasoning_chars`、`trimmed_line_count`、`upstream_request_id` 进 safe-log 白名单（`_ms`、`_count` 后缀自动允许，其余显式登记）。
5. **运营平台**：`packages/admin/src/components/StoryMemoryEditors.tsx` 的 4 个新字段。`admin-client` 跟 schema 自动走，CLI 不需要新命令。
6. **回放脚本**：`packages/backend/src/scripts/story-memory-replay.ts` 跟签名。
7. **测试**（只改已有测试文件，回归锁住这次的失败路径）：
   - `story-memory-compress.test.ts`：
     - 流式拼 content；
     - 思考算首字；
     - 首字超时 → `first_output_timeout`；
     - 流内错误块 / 无 [DONE] → incomplete；
     - 路由头与 body（无折扣底线、provider_order=mistral、latency、1000）；
     - 不带 reasoning。
   - `compress-chunk.test.ts`：
     - 并入超限 → 主线精简成功；
     - 主线精简仍超 → 删最早条目后通过，其他板块不变；
     - 其他板块自身超限 → too_long；
     - 一块最多 2 次调用。
   - `story-memory.test.ts` / `worker.test.ts`：provider 与新日志字段。
8. **验证命令**：
   ```
   pnpm --filter @miniapp/shared test -- story-memory
   pnpm --filter @miniapp/backend exec vitest run src/features/story-memory src/features/generation/story-memory-compress.test.ts src/platform/observability
   pnpm -r typecheck
   pnpm lint:complexity
   pnpm lint:backend-logging
   pnpm --filter @miniapp/backend logging:validate
   pnpm --filter @miniapp/admin build
   ```
9. **发布**：
   1. PR → dev（squash）。
   2. development 环境验证：在 TEST 上找一个够长的测试会话触发压缩，看 Railway 日志 provider=surplus、`first_output_ms`、`job.finished` 成功。
   3. release 分支 cherry-pick → main（--merge）→ Railway 部署 → 同步 dev。
   4. CLI 发布生产 `story_memory_config` 新形状（先给用户看差异，同意后 `--yes`）。
   5. 24 小时后按 prd 验收出数：too_long 任务数、失败任务里的调用占比、首字超时次数、23 个卡住会话的推进。

## 失败路径

- **Surplus 无卖家 / 404 / 5xx**：错误码 `http_*`，任务退避重试，旧档案保留。
- **首字超时**：`first_output_timeout`，同上；比例过高按 design §6 停止条件处理。
- **思考吃满 token**：`length` → incomplete。看日志 `reasoning_chars` 与 `output_tokens`，必要时调 `max_tokens`。
- **主线精简返回结构不全**：丢弃这次结果，直接进入删条目这一步，基于并入后的候选删。
- **配置不合法**：`story_memory.config.degraded`，回落默认值。兼容旧形状就是为了避免这条。

## 补充（用户 11-27 确认后）

- 数据迁移 `packages/shared/migrations/20261127_story_memory_retry_cap.sql`：重新排队 too_long / incomplete 等失败中的任务（design §6 第 4 步），先 TEST 后生产，在新后端部署之后执行。
- safe-log 放出 `story_memory.window.planned` 的窗口字段，以后可以直接算强制截断的空档。
