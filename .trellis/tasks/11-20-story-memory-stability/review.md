# Final local review packet

Not staged/committed/deployed. Proposed commit: `fix: stabilize story memory compression and preserve safe diagnostics`.

Validation: Backend 2041, Shared 363, focused 73 tests passed; Backend typecheck/logging/import/format/complexity checks passed. See verification.md for environment issue and exact commands.

Payloads in module-updates.json are review candidates only, not applied. Real upstream quality, per-environment retry_guard and post-release metrics remain release gates.

All paths below are this task; no unrelated modifications were present before implementation. SHA256 is over current worktree bytes; review.md excludes itself.

| Path                                                                     | SHA256                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `.trellis/spec/backend/app/data-reliability-and-security.md`             | `1f78335d8358c558e5fe920f1c0cb2734f35bd54c628380a7167ef41353bf6ea` |
| `.trellis/tasks/11-20-story-memory-stability/check.jsonl`                | `9aaa5b5ecbba76d43547b06fdb6d007b75f5745f1e09bf8b6bbac9c2cf7684a5` |
| `.trellis/tasks/11-20-story-memory-stability/design.md`                  | `1ea1cc0dabee47adf409e0bf64769398174d59cf0b2b84ec8b17ae8052d1c691` |
| `.trellis/tasks/11-20-story-memory-stability/implement.jsonl`            | `9aaa5b5ecbba76d43547b06fdb6d007b75f5745f1e09bf8b6bbac9c2cf7684a5` |
| `.trellis/tasks/11-20-story-memory-stability/implement.md`               | `c1dd56be9fea117308f634051af5da8fcdae480566ef83bc818d70d738e9cc77` |
| `.trellis/tasks/11-20-story-memory-stability/module-updates.json`        | `2e276dd97a209b5f7f7374a8cb8db122a9aabba227006646a872cc784f9f54a1` |
| `.trellis/tasks/11-20-story-memory-stability/prd.md`                     | `5b0ccc81f411e47cf834a28e62f7e2bf5b21ac702536f15af145e3fce637d158` |
| `.trellis/tasks/11-20-story-memory-stability/task.json`                  | `c38252e1c92f8f38887694f3acb6e963440ab04a53112990ec0439b0d6ddc52e` |
| `.trellis/tasks/11-20-story-memory-stability/task.md`                    | `b171fd8ffdd1d256fd98fdc6517f55ebe65b23f21ae89069e30e4329bfd064a5` |
| `.trellis/tasks/11-20-story-memory-stability/verification.md`            | `af3d91053bb73534199d4be9d8d7531f98050f173d0eaea9461333e13a4c3c7e` |
| `README.md`                                                              | `e2125ebe7ba197e39c9bfd5127479e7ac85a1c0139dee1f4b0fb658e053bdf2e` |
| `docs/ARCHITECTURE.md`                                                   | `d4fd640cb6288975c4176558e247a1646b371f3ecc26d1ddeca6b295367fdb6a` |
| `docs/backend-observability-runtime.md`                                  | `120ffec3627d42a1f5faff4c1a5deb399174320d2b5110fe432fe816e40c1c53` |
| `docs/story-memory-compression.md`                                       | `88503f887e8a200f3b7c6199ceb819aa8711c904745210c2133c0315a8a0f820` |
| `packages/backend/src/features/generation/story-memory-compress.test.ts` | `f27b33cd04c941e50c2f215f89f60e504d04d5dbd2b29ea7aa3b3052ceea146d` |
| `packages/backend/src/features/generation/story-memory-compress.ts`      | `8f80d7ab6f8a276843540b8bafd291f3812aa75bb48a535b775310da10c7c566` |
| `packages/backend/src/features/story-memory/compress-chunk.test.ts`      | `61e06f05e141bab5469fa1cb63f2c4814088473e3b538efa89e6c492860b60e4` |
| `packages/backend/src/features/story-memory/compress-chunk.ts`           | `161f194b80ed876273ffc100bb7687b1dc5c8e0559fe101aa00a1ffae1f4e375` |
| `packages/backend/src/features/story-memory/compress-job.ts`             | `84c272f9aa40ef4e4eca88a843dc188dcc45ece49b95352724f45f6151e7c596` |
| `packages/backend/src/features/story-memory/compression-attempt.ts`      | `ceb733a86c7c80eee377ed91868e1c3204aaca2ac5316f3692fd1295eeee0a6d` |
| `packages/backend/src/features/story-memory/text.ts`                     | `56aff61ae20e554d5a7333faca962ad00d67eaea986ae412caaebd75ff27dbda` |
| `packages/backend/src/features/story-memory/worker.test.ts`              | `72924bb4b78d260293ace1aed4812696801601d59d6ae08889b7a57f35bb111d` |
| `packages/backend/src/features/story-memory/worker.ts`                   | `e022e21e2c3285388d829f1be98bc1c55fff5802e7969b1931bfae7f80891aa3` |
| `packages/backend/src/platform/observability/labels.zh-CN.ts`            | `97991e5fcc47b8368ad58a950d3a1543fc8b7af9fa9f5d9114ad5d2cd5134eec` |
| `packages/backend/src/platform/observability/logger.test.ts`             | `14e99508db85a1df336f24d06b115285fb54883eed6bf138c121018f8e7f23f3` |
| `packages/backend/src/platform/observability/safe-log.ts`                | `b7e2f5db6d34c97910fbe7cefd3921f19bf877a65335d6904a1820e196198e41` |
