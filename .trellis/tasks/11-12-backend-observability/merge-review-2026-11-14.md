# 最终审阅清单（2026-11-14）

本轮处理 HEAD `043c60dc` 与待合入 `f25d969b` 的冲突，并审计/补齐日志接入与规范。开始时上游自动合并文件已暂存；本轮没有 git add/commit/push，5 个文件的内容已处理，Git unmerged 索引待最终人工审核后标记解决。

## 审阅内容与验证

冲突文件为 image-plaza.ts、models.ts、conversation-stream.test.ts、shared index.ts、complexity-baseline.json。保留上游文案、新增功能/出口和本分支日志/错误迁移/拆分；逐项取舍及修复的 8 类遗漏见 [审计记录](research/merge-audit-2026-11-14.md)。实现和规范变更只服务于日志适配，不新增业务查询/重试/计费行为。

验证已通过：Backend 162 文件 / 1750 项；Shared 239 项；Frontend 流式/发送 83 项，最终文案合并后流式 32 项再跑通过；Admin-client 12 项；全工作区 typecheck、两端 build、ESLint/Prettier、日志门禁 323 文件及 3 项自测、Python 规划 8 项、两个任务声明和模块载荷校验、复杂度 34 文件/102 函数、migration 命名与 diff 检查。依赖安装和 Prisma generate 的环境修复及已有警告见 [验证记录](verification.md)。

仅修复工作区；尚未部署、执行 migration、访问生产业务数据或验收 Railway/P95。构建沿用现有 Sentry sourcemap 上传配置。

## 拟执行的索引操作

人工确认本清单后，只对下面“拟暂存路径”执行 git add，标记五个冲突已解决并暂存本轮日志修复/规范；本次操作不包含 commit/push。保留开始时已有的上游自动暂存内容，不把未识别的后续工作区修改混入。本清单或所列文件改变后需重新审核。

依据 `.trellis/spec/docs/process/index.md`：“取得人工明确确认后才能执行 git add / git commit”。审阅完成前，Git 仍会显示 5 个 unmerged 路径，这是尚未变更索引的状态，不代表文件仍有冲突标记。

## 拟暂存路径与内容摘要

下面列出每个最终文件的 SHA-256，便于确认前后内容一致。本审阅文件自身不参与下面的摘要，但属于拟暂存路径。

- `.trellis/agents/check.md`
  - SHA-256: `9a6367de04112eed4f7c0e06cbdbdbf5d0b2912744338e57274ef04944136e96`
- `.trellis/agents/implement.md`
  - SHA-256: `86383e816e4df2e9ff766a187c9da84e6c46525bd96b6ca4b51cffb654333bd8`
- `.trellis/spec/admin/app/index.md`
  - SHA-256: `0b77661287e301906531926c24ec699123dc75b7f9c88b0e3eb36780a62fe59b`
- `.trellis/spec/backend/app/data-reliability-and-security.md`
  - SHA-256: `184559b622070bedb1ff2cb77986a6509b449caeebf1080fe43f73feb712ace4`
- `.trellis/spec/backend/app/index.md`
  - SHA-256: `a0cb154a77a44a4ce0fa4b01a702d8db0589f1a6c4fb9eb26e3820fd42038869`
- `.trellis/spec/backend/app/logging-integration-planning.md`
  - SHA-256: `4da2d6a2bc4e3acd593cb1b5fdc5d79f97a9a6c3ba50a298d4fe81c3d7d3d9c0`
- `.trellis/spec/frontend/app/index.md`
  - SHA-256: `1635477a2e4f2866859f81b710aec40cdae6a0321b81eb4d497a45b385132413`
- `.trellis/spec/shared/contracts/index.md`
  - SHA-256: `2654e5b51f8e96502e48e734259c41b73ca909a014133736512ac5fff40d0315`
- `.trellis/tasks/11-12-backend-observability/check.jsonl`
  - SHA-256: `dac53833df595ee2ff3e81f891fd68d2dfe1bb284a73bd7d0f3932e8dde66ded`
- `.trellis/tasks/11-12-backend-observability/design.md`
  - SHA-256: `8c9d3e26c4f012ddca22da92e3c8976cbbf44fa507a506cb5296cf1deb122510`
- `.trellis/tasks/11-12-backend-observability/implement.jsonl`
  - SHA-256: `dac53833df595ee2ff3e81f891fd68d2dfe1bb284a73bd7d0f3932e8dde66ded`
- `.trellis/tasks/11-12-backend-observability/implement.md`
  - SHA-256: `970d879eb2425b3f4d35a69a082913c20c58c132addf6b0d4db16230733d06e6`
- `.trellis/tasks/11-12-backend-observability/module-updates.json`
  - SHA-256: `c0c1e594f84061142e57473e42a87c4b48f2ef5e675885828e19dc525c3bad29`
- `.trellis/tasks/11-12-backend-observability/prd.md`
  - SHA-256: `5cfb0f847cc4498779b1c53967e5338220210d464784e4866d5e8dc8fb892160`
- `.trellis/tasks/11-12-backend-observability/research/merge-audit-2026-11-14.md`
  - SHA-256: `4ec98971887f47f2912782ea116a3e731faa69728777e6714c626c5f08b747ae`
- `.trellis/tasks/11-12-backend-observability/task.json`
  - SHA-256: `a1ddaacc9c29ad10ba6c37d6239394b2d3ac7037063117bc278ddf91fa0d27ea`
- `.trellis/tasks/11-12-backend-observability/task.md`
  - SHA-256: `57a80d0cbcc45e713ea8f470d6b5abbe26f58eadc91c5ab5b8054a0cc41812e5`
- `.trellis/tasks/11-12-backend-observability/verification.md`
  - SHA-256: `bb38916513ecde8bf881ce924fb7bb87b03d84583632edb22487f06c021d4d76`
- `.trellis/tasks/11-13-growth-prompts/design.md`
  - SHA-256: `e2f5e61d2cd772917aefa541ea6d1e99aed03741daf126bae12aa59338bf7046`
- `.trellis/tasks/11-13-growth-prompts/task.json`
  - SHA-256: `03c7587a3c702cceb8e417156d10122f9cdb989c5c52a5cd7914248394a76d63`
- `README.md`
  - SHA-256: `572c6a961c8bc313ffe6bfe4c8b1201557d02a997602393b3fa21d793584cabe`
- `docs/ARCHITECTURE.md`
  - SHA-256: `3147b0f547c2b44ccdef0bdefba03f09ffec0f7d0574d64c86df17cd73618947`
- `docs/backend-observability-runtime.md`
  - SHA-256: `f630fa9a4fe7b8bd6de694771e571ff4af914769fcd467a6e89ca8412e0811a4`
- `packages/backend/src/features/community/welcome.test.ts`
  - SHA-256: `1b8dada3a08b5889aaac6a3ede8d7a742e85019aa0fd3d3db633af62cba7dab8`
- `packages/backend/src/features/community/welcome.ts`
  - SHA-256: `1a674c93d471af2740f87b60818dee92ffd566bce781a8ed1f770f4fff8f2286`
- `packages/backend/src/features/image-plaza/job.ts`
  - SHA-256: `bbdd4778dc3bfd31e0d03e857d29bc8b9467d7f4f9feb268244607b768b9493a`
- `packages/backend/src/features/image/job.ts`
  - SHA-256: `4792831249fc57e6f143553e137241c43101cdd757683aff81cb7607483a523d`
- `packages/backend/src/features/payment/usecases/PaymentOperationEvents.test.ts`
  - SHA-256: `21e86e68e9f47a4a51564affb9dacc8ebc9e873ffc7246f3588c42af2b81cadf`
- `packages/backend/src/features/payment/usecases/PaymentOperationEvents.ts`
  - SHA-256: `54d0865355771ca4ace35d06d122c40ce5123d3e89564ea5976a500f294d70be`
- `packages/backend/src/features/story-memory/worker.ts`
  - SHA-256: `d817c7ed61c9fa3d69292c50667459175acb37446defaaa8792592e97d075c9f`
- `packages/backend/src/infrastructure/repositories/ChatSessionRepository.observability.test.ts`
  - SHA-256: `2a41bc96c1f548f3e4c16bb652aa051dce2e226bc163887ade7b26029631ce60`
- `packages/backend/src/infrastructure/repositories/ChatSessionRepository.ts`
  - SHA-256: `7e29eda79ef1fe3ccfcc9af6f561ed8de737ee8731fc3c28b2d9b2d7bbab341b`
- `packages/backend/src/lib/db.ts`
  - SHA-256: `eb10804553de4233671a5ee8ea2e75757edb568f0455f321412358de57579d5e`
- `packages/backend/src/lib/lobby-ranking-refresh-job.ts`
  - SHA-256: `a7a87878077a24c90f58dcc67cfa43d957c7baa5c46ef3f48dbd1161a6738095`
- `packages/backend/src/lib/logger.test.ts`
  - SHA-256: `1e2f04174cde5359b86dc0e4278eaac923a9266b7899027205c911a4fa9e29e8`
- `packages/backend/src/lib/logger.ts`
  - SHA-256: `8f9c4abca18191a72d5d4dc974c705700620e479569b37058c8df8eb969ab178`
- `packages/backend/src/lib/postgres-advisory-lease.test.ts`
  - SHA-256: `5acd84bc52e667262bf0502ff6082bc5257fe5154207fe27b953f844587ab55c`
- `packages/backend/src/lib/postgres-advisory-lease.ts`
  - SHA-256: `2df5fe8f409b40a91dc3ff9a11a6b30836e12b83546a69cc267051d09cd1a1d6`
- `packages/backend/src/platform/observability/business-context.ts`
  - SHA-256: `01297244c718ce510f19f839920747dec462344661c5fd4bd7d961cfe01a7bf9`
- `packages/backend/src/platform/observability/http-business.ts`
  - SHA-256: `3b681f3570bcce28d2e9740cad4b6b6cc11921edab131bb7ec76060297f88f7b`
- `packages/backend/src/platform/observability/http.test.ts`
  - SHA-256: `93741b884c9811bc5b68d80a19ddb239911a6bfe58db1ba7780fe1753986e58e`
- `packages/backend/src/platform/observability/http.ts`
  - SHA-256: `130163c976682f890ff7e97f8c630fa43e2d37f7fdd405e3d53794eec89ae217`
- `packages/backend/src/platform/observability/prisma.test.ts`
  - SHA-256: `e6d3aeca0f492a31b85aac78195c4b4d4a8ae15896547b4fe3ddb91ac395b908`
- `packages/backend/src/platform/observability/prisma.ts`
  - SHA-256: `cb20710d291c8abdea507d44af880f86df4a9b7b56ccd84cc1c1b7f600ce48da`
- `packages/backend/src/platform/observability/safe-log.ts`
  - SHA-256: `96620413ae9c5a28cb95dc468d7070b084e36ccee845bd669b77aaa93f998f40`
- `packages/backend/src/routes/community.ts`
  - SHA-256: `b9202039f7c7e1b4f3244d7e1883129e7976242ae5dd3d108c642a9fd27b726c`
- `packages/backend/src/routes/drama-survey.ts`
  - SHA-256: `65b9557e4c6751a221f129efbd367946cb59f0c3190672e2d8699320b7e905eb`
- `packages/backend/src/routes/growth-prompts.ts`
  - SHA-256: `f815bdb12e192979c46ab95f252d8182fff011bb92272e7a8c591e926b7f1189`
- `packages/backend/src/routes/image-plaza-errors.ts`
  - SHA-256: `f12ae935fa7e676b6d18c9c101a1ff6e2233613e8e3552d6b8a973a453ce1503`
- `packages/backend/src/routes/image-plaza.ts`
  - SHA-256: `bb0f04556d46fe1a554e1965ad41cd985400d02a361b9c8e0b6a76f504109b4f`
- `packages/backend/src/routes/models.ts`
  - SHA-256: `c665aaeb9e1a9e7467de5cab26dbe5edb5deafdf9c5864de2931a4c9b7557edd`
- `packages/frontend/src/lib/api/conversation-stream.test.ts`
  - SHA-256: `6b6782e846dd11b34ecc9878def7d93f2c003eba3fba72a0ce24e1cfe350902d`
- `packages/shared/src/index.ts`
  - SHA-256: `42d432aee66943b7adce63dcac0c0face852eafcf5b082a0650e5a0140876caa`
- `packages/shared/src/logging/conventions.ts`
  - SHA-256: `d65bf31fc579e6e79a1ba2559aaaae3daee3dcf165066f5c8f4c8ee0e68b6a40`
- `scripts/complexity-baseline.json`
  - SHA-256: `615d369e040eee010c6b7ac96d76e52269043be4daa78ffba0b5469362220fe1`

- `.trellis/tasks/11-12-backend-observability/merge-review-2026-11-14.md`
