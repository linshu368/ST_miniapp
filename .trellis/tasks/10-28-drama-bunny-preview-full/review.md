# 最终差异审核（未stage/commit/push）

基线 e7225b2891e27c9752ddabe17b93c484dd3dc336；分支 codex/drama-bunny-preview；PR #525 base dev。

## 一个提交

建议消息：feat: route pr-525 drama playback through Bunny

普通接口在pr-525+TEST显式启用后签发对象级Bunny地址；保留私有源/正常鉴权/归属检查；删除独立实验页面/接口/状态/专属契约和上报；扩展既有签名与环境回归。Frontend不新增入口或provider选择。

## 验证

详见verification.md。shared185、Backend45、UI42、全包typecheck/build、适用lint通过；前端全量5条既有media-cache失败。模块载荷最后已通过定向阶段，但全库旧文档基线失败，尚待决定，不继续尝试。

## 拟提交路径

- .trellis/spec/backend/app/data-reliability-and-security.md
- README.md
- docs/ARCHITECTURE.md
- ops/drama-bunny-preview/README.md
- packages/backend/.env.example
- packages/backend/src/app.ts
- packages/backend/src/features/drama/cdn-experiment.ts
- packages/backend/src/features/drama/signed-url.test.ts
- packages/backend/src/features/drama/signed-url.ts
- packages/backend/src/platform/runtime-config.test.ts
- packages/backend/src/platform/runtime-config.ts
- packages/backend/src/routes/drama-cdn-experiment.test.ts
- packages/backend/src/routes/drama-cdn-experiment.ts
- packages/backend/src/routes/telemetry.test.ts
- packages/backend/src/routes/telemetry.ts
- packages/frontend/src/app/drama-cdn-experiment/page.tsx
- packages/frontend/src/components/drama/cdn-experiment.tsx
- packages/frontend/src/components/drama/drama-player.tsx
- packages/frontend/src/lib/api/client.retry.test.ts
- packages/frontend/src/lib/api/drama.ts
- packages/frontend/src/lib/api/telemetry.ts
- packages/frontend/src/lib/perf/drama-cdn-seek.test.ts
- packages/frontend/src/lib/perf/drama-cdn-seek.ts
- packages/shared/src/**tests**/telemetry-contract.test.ts
- packages/shared/src/api/drama.ts
- packages/ui-tests/fixtures/server.ts
- packages/ui-tests/tests/drama.spec.ts
- .trellis/tasks/10-28-drama-bunny-preview-full/check.jsonl
- .trellis/tasks/10-28-drama-bunny-preview-full/design.md
- .trellis/tasks/10-28-drama-bunny-preview-full/implement.jsonl
- .trellis/tasks/10-28-drama-bunny-preview-full/implement.md
- .trellis/tasks/10-28-drama-bunny-preview-full/module-updates.json
- .trellis/tasks/10-28-drama-bunny-preview-full/prd.md
- .trellis/tasks/10-28-drama-bunny-preview-full/task.json
- .trellis/tasks/10-28-drama-bunny-preview-full/task.md
- .trellis/tasks/10-28-drama-bunny-preview-full/verification.md
- .trellis/tasks/10-28-drama-bunny-preview-full/review.md

## 明确排除

- ops/drama-bunny-preview/evidence.json（上轮未提交证据）
- ops/drama-bunny-preview/experiment-closed.png（上轮截图）
- 其他worktree/main已有工作

## 发布权限与准确操作

本次尚无云写。内容批准不自动等于push，须明确授权二者；不merge dev/main。
在pr-525保存新TEST动态回源规则、将全路径Block Request改为除/preview-test/\*外均阻断、保持原生token验证。这样Bunny可分发TEST目录中所有经现有鉴权签发的对象，不向CDN提供全库密钥。
仅Railway pr-525/stminiapp设置DRAMA_CDN_ENABLED与专用DRAMA_CDN_TOKEN_KEY，移除旧五个实验变量；不触及Production和其他服务。先受控真实预检，失败停止/回退，不以SUCCESS宣称成功。

## 后续状态

用户随后明确授权直接提交推送，并确认Bunny TEST访问范围变更；代码与切流部署已完成。此文件保留第一次提交前的审核快照，最新结果以verification.md和acceptance.json为准。
