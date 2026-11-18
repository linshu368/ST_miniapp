# Final review packet

Local implementation is ready for human review. No files have been staged or committed; no remote migration or deployment was performed. Runtime semantics, release order and rollback: `docs/media-plaza-feed-ranking.md`. Validation and remaining gates: `verification.md`.

Proposed single work commit: `fix: unify media plaza ranking and two-column loading`

All paths below form one coherent change: contracts, additive ranking migration, backend consumers/maintenance, fixed two-column frontend, video observations, regressions, runtime documentation and required Trellis planning/spec artifacts. No unrelated dirty paths were identified. The task remains in progress for remote/real-device/window acceptance.

Review the complete diff with `git diff`; newly added files require direct inspection. Current raw-byte SHA256 values below freeze the proposed content; this review packet is excluded from its own digest. Any later file/content change requires renewed final review before staging or committing, per `.trellis/workflow.md` Phase 3.4. Archive/journal changes would be a separate later review.

Files: 74. Aggregate SHA256 (sorted path + NUL + file SHA256 + LF): `d803d19e3ea1fdf243585fd6763c73385d9434765d6959d28dc8510fbc822f00`.

## Proposed file list and SHA256

```text
a3dd0caae0127196823be8ae6dabc0aeefdae7a76e7f438ea9b3fa918af45a07  .trellis/spec/backend/app/index.md
f24d2b79c01804f3ae2ab3b20104e76f01dda30cc4f797581bf8f0127913aac9  .trellis/spec/backend/app/modules/business/conversation-generation.md
5bbd21b48cce9b3ea0a7a6a76d8eb588d20000ed4b0697e2191e193d66f43871  .trellis/spec/backend/app/modules/infrastructure/runtime-data-security.md
e46c652866e7aecba5d9d8274740f1c0c21b3d446e6e8416bfe068c6f8125926  .trellis/spec/database/supabase/index.md
2786c69868a20518ca55d469c7c19002dda3ce3ba83a390e2e989ae48eef310a  .trellis/spec/database/supabase/modules/business/conversation-storage.md
5d5ed736733f94c621d9b8871e9a0ead08b2501db15167cc4ba63c60348c8a9c  .trellis/spec/database/supabase/modules/infrastructure/schema-security.md
9b266b874cadfe484c365ee3de63fa59fd36a5c89e22ddff4e0007303d51c626  .trellis/spec/frontend/app/index.md
ac193557b3cb04edfbaddefd37158f0f14a065723719332efc3a240cff6c03bb  .trellis/spec/frontend/app/modules/business/conversation-ui.md
e60d96089ea128b45763d1379fe1db910f031aa22ae4791d962383fc9cc3daa2  .trellis/spec/frontend/app/modules/infrastructure/client-ui-foundation.md
e3ed8f2ba44bd7ecd5534d688539b9bcb29ea716b4c08f56939ac9e95670b9d5  .trellis/spec/shared/contracts/index.md
3e750467cee4f587404028d3741459fb34dbdb62ff240f7bddaa8600748e6c66  .trellis/spec/shared/contracts/modules/business/conversation-contracts.md
d951bedba25673416fd9de456b5a97164426d4a1eb8467f2190baaf0ad06e962  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/check.jsonl
08734682c2a6f8ecf77b80219fac743dda9dc57515bad85ca3ff0efc03fd04a8  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/design.md
69d0e2738d4b6ba7c9e262f8ac253232c9a23e04fe9b0c15513b9093bcb41704  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/implement.jsonl
71fd69a6867f4cb9eae72e63fcc61fe3de1afe35b74b38ab2bac2a80d292d361  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/implement.md
41d74d65502a6f14cb03304bad2d5bce796414670e0b5f3c3b23d07014a45e7f  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/module-updates.json
4f9f4334d7fd8faeb5d9a9e4d63d441bf3c3a4eda86ac074c8fb1e1ab042fc66  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/prd.md
a4131c8d8255a20b1889e7c1211186df5c8565a87d51772dfff939582c35314c  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/research/current-behavior.md
167d74f686b939391caf39def56891e17301cb6c1ffec277a7cfad54df71cefe  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/research/observability-contract.md
c268955677a6596406030c76cdee6e6ddcb34746d917d5b2b10287252d117795  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/task.json
353e19abce98c9d3aee81555a3992227262f3dd3568ffc283c650e536e620999  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/task.md
bada1adfc445ec1aafe98ac16d9f320022844121d862fed04dcac7d29855cdc8  .trellis/tasks/11-18-media-plaza-feed-ranking-masonry/verification.md
278072ba92b9de0f31acd970f1b13a4813e770dcc9066f2ae1a9f42dd5dcd639  README.md
f8a09eddcf67835d695cac865ba004ab99606ea224d93da5765f932d408e9f94  docs/ARCHITECTURE.md
4d80cf5beb08299fe0d661683409cbf9e2a3bc9bfeac948145fb20731a0173ec  docs/db/registry.yaml
989dbcc83030aba1e520706a33136b498751472e2bcc3142bab3de46d2bf5bd3  docs/grafana/engineering-performance.md
e9edb3aec8e6bcb234d96939eb8b27cb1078cba71df29c154b96d4f7ff841fab  docs/media-plaza-feed-ranking.md
1fd1817daa1f6c9837a06fb4b763ead028f0c4fa4a36a8e3342e5405ad70bb82  packages/backend/package.json
1babf83ac177011da6d3e902896958210e5a825fdc3a409c3091df0fb77482cd  packages/backend/src/features/image-plaza/feed-cursor.ts
0adde93cc4624bdc3664b92d9b96b05802438d56580441e04448afee5fc35aff  packages/backend/src/features/image-plaza/feed-ranking.ts
70a31e879f80f11a6036a9d15f746802a161f8d05bac19df10615d89500f0f29  packages/backend/src/features/image-plaza/repository-feed.ts
7b207bbd5d26af5c8f93537cdfabb10a0b423ffb4122199f7e118ae30a7966ef  packages/backend/src/features/image-plaza/repository-model.ts
b0a46aef918eef5d1d8fa7d4b0eb73fe722a2d4f012f97e8a922b32ba1de5061  packages/backend/src/features/image-plaza/repository.list-works.test.ts
777cfaa921983d00bb0ce220080ab8997d0868b664f44713f356212f9ea8bfda  packages/backend/src/platform/observability/labels.zh-CN.ts
ef395daad331d3c6ffd91de6be7c332b8965305d6fb809eab6fa801e898c12da  packages/backend/src/platform/observability/logger.test.ts
20880a1a75a64c19ba53d75a8bbaa08f5e90f3201c35435ce2b4027e3709901e  packages/backend/src/platform/observability/safe-log.ts
62646e9d052421ac7433002b807b2db666d5e7abefd541da2b16b7cfe637a19e  packages/backend/src/routes/image-plaza-feed.ts
3f265cc1cd5b8044f5ddbedee3c9fb92de74e141bba5ce235d91c43624bce5ab  packages/backend/src/scripts/import-image-plaza-seed.ts
a2ffc3aaf019c28a78fa33b5177d13253332f3772eb488c964abd488b7795c73  packages/backend/src/scripts/rebuild-image-plaza-feed.ts
537021c0e52cdb4bca58d65002671d4f537de6e01603369b63dc78bbb7a7734b  packages/frontend/src/app/(main)/create/page.tsx
a1d8ae4d0a84c5b592e6dc6e5b23ef64d914e34da377f7c4eacfd4a1884f6997  packages/frontend/src/app/(main)/create/work/[workId]/page.tsx
41e176e6661b1ec5c66d3ae519e783b650171a20e7b1a749b60cdac026904073  packages/frontend/src/components/image-plaza/plaza-card.tsx
54e9d3cc3d5aa2a8100d1b34d76e1b22369d638934225f66cd3ce4c64aeb59e9  packages/frontend/src/components/image-plaza/plaza-gallery-content.tsx
b37bec4227aacc49a4aa1292205e4b8672c6d91b9e958f8fa8a8df77e6d168dd  packages/frontend/src/components/image-plaza/plaza-gallery-header.tsx
9fe5ec1bb5f802b0ea82acd2ef5edf4c94891696ed2a1dd71acb3bee6d068a67  packages/frontend/src/components/image-plaza/plaza-masonry-layout.test.ts
fd2aec7a1824a11194fc67384298504f80a80cf6f9bdb18b9da32ac4bcd73eb3  packages/frontend/src/components/image-plaza/plaza-masonry-layout.ts
41c785e1d1f2245fe5d59767673d5f579dff668a23ae346ab7a444c4fdfbc544  packages/frontend/src/components/image-plaza/plaza-masonry.tsx
6a51e7e36e1d276944ca030c435fcec3718a093abda3b87d2f36bcaef6d9870a  packages/frontend/src/components/image-plaza/plaza-video-observer.test.ts
88c165e13877df132b38ef2dc497a5481d682e57e163f1a8d49c606da7317997  packages/frontend/src/components/image-plaza/plaza-video-observer.ts
dffbf5333c8bfc0e4732879ad7f124254d791ecbbde83239a188b79f0053925b  packages/frontend/src/components/image-plaza/plaza-video-player.tsx
312da8c191fe87b53e7066b4fe939f769901abcfac2fc66d1434b1999671ef8d  packages/frontend/src/components/image-plaza/use-plaza-gallery.ts
88913eae35170ee2d954dcca221d495ac268f382f2314f6327f2befe6acb4098  packages/frontend/src/components/image-plaza/use-plaza-poster-timing.ts
3e1fbdcd9edaf359a265a7c309b07cd216bcf7c76455b571554f8260dae4313d  packages/frontend/src/lib/api/image-plaza-feed.ts
cbd576ebd157c6f4029d5585bbf3585e2b74e0734babe738ffbf0c2a3b0bec44  packages/frontend/src/lib/api/image-plaza-keys.ts
adf5c3cdf454a00e489b51000cd300b1411bdb31ecf940199ceb24aa87de961e  packages/frontend/src/lib/api/image-plaza.ts
3d87c5e60d1d6142d3a9dcbcdee35e2fa15084201442a0055a0f1fce68edffcd  packages/frontend/src/lib/perf/api-timing.ts
0cf3cbc644cbe0f8463c61f9b3972ea466b206df46fba354ee64d134c75451f6  packages/frontend/src/lib/perf/grafana-schema.ts
06688d295cdfd9d5144b4a21bd8b019cb175c45f8669c45c61078a35d966754f  packages/frontend/src/lib/perf/grafana.test.ts
00ffa7af83e2be7d5794d2e467b85c4f5c65f6e05921864700bbacb7fb731059  packages/frontend/src/lib/perf/grafana.ts
903ae9e5c560a9fba80a0f9a1a8522be64725021ed3542e7b38d3e90d2a10a60  packages/frontend/src/lib/perf/plaza-metrics.test.ts
1d31f646ca466f4ccf11a74df08bcbc99bc0c5fd543cd26d802db71f0b777f00  packages/frontend/src/lib/perf/plaza-metrics.ts
e64001a8bf3095a5d84da37559ca41b29b8d7de80ef7d5e8217919cb0cb863c4  packages/frontend/src/lib/sentry/sanitize.test.ts
eddecc06742218619c8aedb1f5b9690fa4868932622a06b5aca9d58146d64ef1  packages/frontend/src/lib/sentry/sanitize.ts
262d202b745b4d152c2fa34c739cb536ce1715c42bae9743d5a26a5b9dffff5b  packages/shared/migrations/20261118_media_plaza_feed_ranking.sql
dc495a6774dc66148a02a7ce038df6e463e390335b1a6a642e4793b48fecf63b  packages/shared/src/__tests__/image-plaza-contracts.test.ts
e9f98f12f9219a23c5ba09e6c7af5cd854b1bc968e20eb57a7d50d6f551b0bd3  packages/shared/src/api/image-plaza-feed-cursor.ts
35856f910595929be8c284f5ede38313992d45ee48c3ecd44754f8bb9e319342  packages/shared/src/api/image-plaza.ts
bcae39b1695d94e901d947073a4f09d1c65eca0022bcd66790b43a6848790337  packages/ui-tests/README.md
9cffd8207f237eb267d9c5234c23c4e1d73980773849b3392b29fbff5a378241  packages/ui-tests/fixtures/data.ts
a5995a70ec6e45321a10c41e23019f7c730f272501a0af019889d25ca4cacde5  packages/ui-tests/fixtures/plaza-feed.ts
b158c7afc504e801ebd99c916e317763fd7db0124ff04100d7dc7ff8d3727b4d  packages/ui-tests/fixtures/server.ts
6039041ff6975dead63519a50efb8e80078f399263dae88a250d33f95b088fc2  packages/ui-tests/tests/image.spec.ts
ce5eb2696b0931b54618793c0f7db452cc6a26985b87ddc43a000a4df763f2a3  scripts/complexity-baseline.json
e31a376b9699bfd90f83454a61cbc34ecc9a42f24f5b537f6bffd1cba785ddf6  scripts/test-media-plaza-feed-ranking.mjs
```

Also include this `review.md` in the proposed work commit; inspect its final text directly. No approval to stage, commit, push or execute remote work is inferred from implementation authorization.
