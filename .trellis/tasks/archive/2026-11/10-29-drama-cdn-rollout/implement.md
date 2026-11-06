# 执行计划

## 门禁与顺序

- [x] 完成实现调研、需求收敛、复用／故障模型／最小方案／恢复设计。
- [x] 用户已在 2026-10-29 审核并确认实施，task 已进入 in_progress。
- [x] P1 shared 兼容契约 → 后端配置／分桶／生产签名／缓存／路径返回。
- [x] P2 前端新播放确认路径 → 启动上下文／入口总等待／恢复根链 → 快进提交前观测／目标帧。
- [x] P3 telemetry 服务端去重码／日志白名单／seek 分支 → 只读比较脚本。
- [x] P4 扩既有单测与 `@drama` fixture／用例 → 适用测试／检查 → README／架构／spec／运维说明。
- [x] 提供最终 diff／文件清单及真实验证；未批准最终内容不 stage／commit／push。

## 计划验证命令

以下为实施阶段计划，不代表本轮已通过。

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend exec vitest run src/features/drama/signed-url.test.ts src/platform/runtime-config.test.ts src/routes/drama-timing.test.ts src/routes/telemetry.test.ts
pnpm --filter @miniapp/frontend exec vitest run src/lib/perf/drama-timing.test.ts src/lib/perf/drama-media.test.ts src/lib/perf/drama-observer.test.ts
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend test
pnpm -r typecheck
pnpm -r --if-present build
pnpm --filter @miniapp/frontend lint
pnpm lint:imports
pnpm lint:legacy
pnpm lint:migrations
pnpm test:ui --grep @drama
python3 .trellis/scripts/task.py validate .trellis/tasks/10-29-drama-cdn-rollout
python3 .trellis/scripts/module_knowledge.py check .trellis/tasks/10-29-drama-cdn-rollout
git diff --check
```

缺 Prisma Client 先正常 generate 再判断类型错误；不删锁、不清他人缓存。只格式化本轮文件。模块文档存在旧基线缺章，若阻断记录边界，不扩大到全库修复。

## 必须覆盖的失败矩阵

- 未鉴权／错误归属；环境错配／篡改／失效 token、缺 key、签名失败；热缓存不能绕过鉴权。
- 同用户跨实例稳定；关闭原组不变、实际路径改为 Supabase；旧缓存／预取／在途晚到不能写入 src。
- 4.9／5／5.1／30 秒、等待中失败／退出；5 秒不暂停视频；start／slow／final 不重复算尝试。
- 未缓冲／已缓冲／缓冲未知、暂停 seek、连续 seek、旧帧、只有 seeked、无 rVFC。
- 失败→重试→成功保留原失败和根累计；换视频隔离；相同用户多次播放仅一个人。
- 重复／乱序／冲突／缺 final、限流／上传失败、导出截断均显式统计，未知不补零。

## 本地验收与生产边界

扩现有 `packages/ui-tests` 的 `dramas`／`drama-play-error` 场景、`drama.spec.ts`，覆盖关闭换路、旧预取、重试和快进；不搭临时 mock 或新增测试文件。此功能建议纳入可重复本地验收，按以上已有验收要求实施。

生产操作单独提供准确项目／环境／服务／变量形状与 CDN 规则。先在关闭开关下完成起始／中段 Range、小段字节比对、热缓存签名负例；每请求有限时限和字节，失败停，不下载整库。Telegram iOS／Android 分别核对起播、快进和关闭重取址；模拟不能替代真机。

本轮不自动生产部署／切流，不提前安排未知开始时间的检查。实际启用时记录时间与版本，再执行 12 小时首次只读比较。提交／推送／合并／配置发布按各自证据门禁执行。

## PR #525 合入 dev 后的继续执行

2026-10-29 用户要求继续。沿用已批准任务，在46159929新工作区迁入本地实现，原工作区不变。保留上游v3唯一阶段计算、home/detail归属、Faro质量窗口、无分析库写入和历史diagnostic导入阻断；只读比较显式读取实验日志，不改变历史导入写入边界。新seek不能投startup，实验结果不能被unified快速成功采样丢弃；正式实验额外核验legacy完整POST。重新验证后生成最终diff、文件与摘要供人审，不stage/commit/push/main合并或生产配置写入。生产只读检查与未通过门禁分别记录在production-preflight.md。
