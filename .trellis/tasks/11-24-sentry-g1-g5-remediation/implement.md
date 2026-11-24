# 执行与验收计划（v3）

用户批准“明确故障修复，未知先补观测再补稳定性”后，已通过规划收敛并start。当前本地实现见[结果](research/implementation-result-v3.md)，因Frontend构建OOM仍保留in_progress。[复核v2](research/review-2026-11-24-v2.md)是历史研究边界，不能沿用旧等待授权状态或10秒/SDK两次重试提案。用户后续明确不做本地UI测试，该要求覆盖原本地UI计划。

## 执行分解

1. 核对HEAD/dev和已有任务/commit，保护原报告/用户文件，不恢复退役入口；任务已start，未自动Git操作。
2. G1显式初始化阶段、安全失败warning及原Errors状态，不自动重入或伪造ready。
3. G2安全布局快照；封面observer合帧/同值保护并拆小原手势，不盲改gallery。
4. G3确证调用方取消仅免error Logs，独立失败保留；QueryObserver/body迟到拒绝验证，期限与取消分开。
5. G4先复现idle缓存/messageerror局部缺口再修，保留启动5秒/执行默认1秒、generation和原文；提交原文后固定reason限量warning。
6. G5沿原requestLogger补identity/RPC及业务终态，原错误继续抛HTTP onError；保留3秒、幂等/owner/恢复次数/计费/SQL。
7. 迁移renderer7项旧契约测试，保留正文scope、安全、choices、通用details与退役块隐藏。
8. 全范围trellis-check：producer/consumer、失败传播、脱敏/日志、typecheck、相关测试、适用lint/build/静态检查。代码通过的检查与构建OOM、UI排除及真实未覆盖分开记录。
9. 当前模板v3汇报、任务证据链、模块更新载荷；不部署或标Issue已解决。

## 可执行验证命令

使用Node>=22/pnpm。测试串行减少本机资源竞争；不运行UI、真实供应商、计费或生产DB测试。

```powershell
python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-24-sentry-g1-g5-remediation
python .trellis/scripts/task.py validate .trellis/tasks/11-24-sentry-g1-g5-remediation
python .trellis/scripts/module_knowledge.py check .trellis/tasks/11-24-sentry-g1-g5-remediation
pnpm --filter @miniapp/frontend exec vitest run src/lib/api/first-token-reports.test.ts src/lib/api/client.retry.test.ts src/lib/perf/request-timing.test.ts src/lib/telegram/hooks.test.ts src/lib/telegram/init.test.ts src/lib/sentry/error-diagnostics.test.ts src/lib/api/conversation-stream.test.ts src/hooks/use-conversation-turn.test.ts src/lib/text-postprocess/artifact-renderer.test.tsx --maxWorkers=1 --no-file-parallelism
pnpm --filter @miniapp/backend exec vitest run src/platform/observability/logger.test.ts src/platform/observability/http.test.ts src/routes/conversations-thinking.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @miniapp/reply-renderer exec vitest run --maxWorkers=1 --no-file-parallelism
pnpm --filter @miniapp/shared exec vitest run --maxWorkers=1 --no-file-parallelism
pnpm -r --workspace-concurrency=2 typecheck
pnpm --filter @miniapp/frontend lint
pnpm exec eslint --no-eslintrc -c .eslintrc.json 'packages/*/src/**/*.{ts,tsx}' --no-inline-config
pnpm lint:backend-logging
pnpm lint:complexity
pnpm --filter @miniapp/admin build
```

Frontend构建须禁用Sentry发布/源图上传凭据，仅本地生成产物；当前两次OOM详见verification.md。Next Windows standalone重建前按规范确认并移动旧快照到仓库内output/build-snapshots，不递归删除junction。未来在资源充足环境重跑，构建通过前不能发布。

原lint:imports别名PowerShell解析--rule '{}'失败，以上直接ESLint为等价边界检查，不修改脚本。命令表中的Frontend9文件是可复现主要集合；实际通过10文件179项还含启动诊断既有测试，最新SDK4项单独复跑，具体范围见验证记录，不把重叠次数相加。

## 可重复场景与回滚

本地UI按用户要求不执行。已复用chat-edit fixture准备Worker构造不可用→原文可读→输入保留→下一轮一次POST场景，尚未执行。复杂流程建议复用现有startup/角色封面/聊天/创作场景补native部分失败、连续缩放/导航、取消迟到与草稿保存、receipt未知重载/切账号；不另建临时服务。真实系统键盘、旧WebView、历史CDN和生产DB/账务不能由fixture替代。

各应用补丁可独立按完整导入单元回退：SDK诊断、请求分类、封面hook、Worker/回调、后端receipt诊断。无持久数据或SQL迁移；保留用户内容、receipt、owner、幂等及未知终态，不清SDK storage或重放旧SQL。Frontend与Backend无需新契约顺序，但各自构建/验证通过才可安排发布；未授权生产操作。本次mobile/logging门禁继续适用，真实性能基线仍null。停止与复查条件见design及task.md。
