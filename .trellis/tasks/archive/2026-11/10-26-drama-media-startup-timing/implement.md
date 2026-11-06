# 执行计划

已审核范围来自用户上一轮明确确认的三类最小打点。约 3 步、5 个核心文件；使用当前 dev_video_1021 工作区，保留所有既有无关修改。

1. shared/api/drama-timing.ts：可选有界 media schema、类型与日志映射；扩展既有契约/接收端测试，覆盖旧报告兼容、未知字段、超限、敏感字段、正常日志与 32 KiB。
2. frontend/perf/drama-timing.ts、drama-media.ts、drama-observer.ts 和 components/drama/drama-player.tsx：有界事件、慢/终态实时状态、Promise 与用户操作接线；不更改播放行为。既有测试覆盖成功顺序、拒绝/AbortError、状态读取失败、迟到隔离、截断、慢报告独立快照和后台/重试。
3. 更新 docs/drama-playback-timing.md 和对应 frontend/shared/backend spec；执行验证，记录剩余人工场景及发布顺序。

## 命令

- pnpm --filter @miniapp/shared test
- pnpm --filter @miniapp/frontend test
- pnpm --filter @miniapp/backend test src/routes/telemetry.test.ts src/routes/drama-timing.test.ts
- pnpm -r typecheck
- pnpm --filter @miniapp/frontend lint
- pnpm --filter @miniapp/frontend build
- pnpm lint:imports
- pnpm exec prettier --check <仅本次修改文件>
- git diff --check

## 人工回归（需部署后，未执行不能宣称通过）

- 限速媒体：对比 metadata、loadeddata、canplay、playing/first_frame 与 bufferedAhead，不能把 pending 认作传输错误。
- 启动期间暂停/恢复：用户事件与媒体 pause/play、Promise 结果可区分。
- 自动播放拒绝后手动恢复：原 autoplay_blocked 保留，不补造成功结果。
- 换剧/重试/后台：旧源事件不进入新 observation，后台终态包含即时可读状态，首帧后不再累计启动事件。
- 检查 /api/telemetry/drama-timing=200 和 media 字段；未知/旧版本导致400时先核对 Backend 部署。
- Range/TTFB/解码具体根因不是本次本地测试能证实的内容。
