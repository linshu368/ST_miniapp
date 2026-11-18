# Final local review packet

Date: 2026-11-18. Task: `11-18-video-spending-records`.

Proposed single commit: `fix: restore video spending and reference cover generation`.

Changes: include existing video debit/refund ledgers in spending, show distinct signed entries and actual balance splits, quote required-reference models as r2v before upload using existing configured prices, and prepare an authorized current cover as an explicit reference when no manual image exists. Manual image wins; a missing or invalid cover stops before paid submission. Conversation source_work_id is optional and maps an existing column. Extract existing button/creator shortcut components to reduce the oversized studio page.

No migration, historical balance adjustment, billing formula change, provider request, production config edit or dependency change. Deploy Backend reader/optional source-field producer first, then Frontend consumers; refresh existing pages. Roll back read/render changes without modifying ledgers or deleting referenced assets.

Validation: Shared 25 files/258 tests; Backend related 12 files/126 tests plus existing HTTP/payment regression collection; Frontend final 79 files/891 tests; fixture protocol 12 tests; all 8 workspace consumers typecheck; final Frontend production build; backend logging guard (385 runtime files); complexity (28/28 files, 98/98 functions); mobile/logging declarations, module payload and Git whitespace checks passed. Existing baseline complexity and build warnings remain; no budget relaxed.

User explicitly waived local UI testing: launched run stopped, no completed UI pass, no restart. Real browser FileReader/CORS/expired-cover behavior, Telegram Android/iOS and production before/after P95 remain release verification items. No real paid generation or wallet business-row inspection was used for validation. See [verification.md](verification.md) for results and limits.

All paths below are proposed commit files; add review.md itself as the review record. No unrecognized/unrelated path was found. No files are staged, committed, pushed or deployed. The task remains in_progress for human review and release validation. Per `.trellis/workflow.md:638`, final human review is required before staging/committing; any changed path/content invalidates this packet.

## Content digest

SHA-256 uses UTF-8 sorted `path + NUL + content SHA-256 + LF` entries. Excludes this review record to avoid a self-referential hash; includes every other modified/untracked path.

Aggregate: `c698252d19842a29b82d700962480f15f84eda444763eed9548f9b397ce555d8`.

## Proposed paths and final file hashes

- `.trellis/spec/backend/app/modules/business/conversation-generation.md` ? `440d01780748cd8d3443bd5fec396bb420c3ad615ae192568f44b86bb9f7d7e5`
- `.trellis/spec/backend/app/modules/business/wallet-payment.md` ? `ded8596a53f785c0fcd7f4c3f6bcf9f8a8e2555a96cbb1375df63fa4d314ff28`
- `.trellis/spec/frontend/app/modules/business/conversation-ui.md` ? `94a068fb6a5d4b511088492269cd75ad4d2c631cb8ab443e7ba87c231fba0b2a`
- `.trellis/spec/frontend/app/modules/business/wallet-payment.md` ? `11b5e1af0b2fc8ea5cb28a69f076e6e468f82ed402fa9c9b82f420aa3e854ec8`
- `.trellis/spec/shared/contracts/modules/business/conversation-contracts.md` ? `b0d9387de9fbf3cc79c8a5dfbc6eea4e29a1624b3b9b1ed1888eb1b6bc390550`
- `.trellis/tasks/11-18-video-spending-records/check.jsonl` ? `b07d08d236963962b98f02165f5c31eaaf15c70072b474458f952f1421887f6b`
- `.trellis/tasks/11-18-video-spending-records/design.md` ? `398606710d34803a0970d3bd9b6b208df8841b4256f1cd85d0c2991b7105fe4c`
- `.trellis/tasks/11-18-video-spending-records/implement.jsonl` ? `b07d08d236963962b98f02165f5c31eaaf15c70072b474458f952f1421887f6b`
- `.trellis/tasks/11-18-video-spending-records/implement.md` ? `1ec93802b9a6a30e8613dc7252bd8c105414c4b06b971316c0c8ebaaee779959`
- `.trellis/tasks/11-18-video-spending-records/module-updates.json` ? `ffe22b6652bb76b7c283693fc9702232e8d524b242b90392b08f323483b43391`
- `.trellis/tasks/11-18-video-spending-records/prd.md` ? `f3d49c3aaab01fb567eb8fe6973cc67c1e3321f32da73642b57e60b34353ab72`
- `.trellis/tasks/11-18-video-spending-records/task.json` ? `c10d66bbfb4253b998077c96a7bebe8e3d5313a880b01f1293e410890b71d786`
- `.trellis/tasks/11-18-video-spending-records/task.md` ? `88c90785a4cf6b22c07bc504a9b7b0f3185a40f12d38c7dea66bd4b8656e6bfb`
- `.trellis/tasks/11-18-video-spending-records/verification.md` ? `f238f897ab1139a14fb87dd8599bce77cfa6f9d2196dfbe77ff11e76ac66b6cf`
- `docs/video-plaza-stream.md` ? `33df5a3ad261cd07453214fed2fa268c3632760cfd659b69a2c281a386feb2ae`
- `packages/backend/src/features/image-plaza/repository-model.ts` ? `17525a2def1f617ac609dd9c99783f1f9f02585f54c610419e32744c0e47f8f3`
- `packages/backend/src/features/image-plaza/repository.list-works.test.ts` ? `7c5b5d8b6e28467394ae907fc37d4dcc926662e464194df5f89690a6018bba9c`
- `packages/backend/src/infrastructure/repositories/MiniappWalletRepository.test.ts` ? `b3db6019730e6162382bb94d69d6c91981c16ad64c2b085cf8c47e72ff845070`
- `packages/backend/src/infrastructure/repositories/MiniappWalletRepository.ts` ? `067a90aba16702e83b2cf8b4cb27e0fe08477648d4d56013d026e20e26f5fdee`
- `packages/backend/src/infrastructure/repositories/wallet-spending.ts` ? `10e358a3f3c6ee21f029cbeeb9c8b2f822939683e6cf15ecfc8bb6d0ec14c933`
- `packages/frontend/src/app/(main)/create/studio/[conversationId]/page.tsx` ? `09771c16e28fa711aa4a1c5d27252be1547832ec8ccc90ccc82e66c88dbd1e38`
- `packages/frontend/src/app/(main)/profile/spending/page.tsx` ? `cd92d1bc9ce3d5fddf6e1aa29b6a8cddf6a12fdead88e2093188c47e1068622d`
- `packages/frontend/src/components/image-plaza/creator-description-shortcut.tsx` ? `bd7f14f06e705bae0b36d8d3e582c81752fcecc865f3f7f818eda65faeafb46c`
- `packages/frontend/src/components/image-plaza/studio-generate-button.tsx` ? `a895e73e367631ec5882437cbff20becde19d959a4fc48a2835d61e23af09bf5`
- `packages/frontend/src/lib/api/image-plaza.test.ts` ? `21df389d4c92de4cb6e8e1998aabe9f2f2e4f2213d1ed3dc8cc43966fa18e3e6`
- `packages/frontend/src/lib/api/video-cover-reference.ts` ? `6008e4c13830af88e603319c41c2566ad887b706636a91d9d6a5544c375ddb23`
- `packages/frontend/src/lib/api/video-plaza.ts` ? `a11b3144c0f0f63f79dea2a2fdeef5d815e32b0db9471f5f43e202c194fa4b56`
- `packages/shared/src/__tests__/image-plaza-contracts.test.ts` ? `677a509a403390025876cb67fa8b619a99f69ebb3cb0c4e096aa1dab2c8eac16`
- `packages/shared/src/api/image-plaza.ts` ? `e074c085e63e187c2534c94f803dc6c8d5f03f3a883f92639ac09a6a2b9d8c8d`
- `packages/ui-tests/README.md` ? `929aff8e30cbad0e1df89863dc91f902aec4ba37b262c7ef9679355c8c7cc1bd`
- `packages/ui-tests/fixtures/data.ts` ? `4451ee4c7e5f84a913ff49250cf584fc9402541d2989f544ffdcfefcfe87c518`
- `packages/ui-tests/fixtures/server.ts` ? `f8d7ed342b605c9e09a0844c1ebbeced7589ae167c12270d74de082818c708b6`
- `packages/ui-tests/fixtures/wallet-spending.ts` ? `c14f78304c78c9c71eb8052fc9b4ba4da65394ee977a2dfcf6b375659ad172d2`
- `packages/ui-tests/tests/profile.spec.ts` ? `59e6a2c5fdf29a5450b6f57e2e142abcfdb1cfeef2a7429050228bc4a5200876`
