# 最终内容审查：广场视频 Cloudflare Stream

本轮代码、独立SQL验证和13条真实Cloudflare资产已完成；TEST数据库及应用尚未切换，原Supabase视频未删除，生产未操作。所有源视频已备份到Git之外。

## 变更和验证摘要

- 未来生成统一Stream，Supabase只保留稳定引用、封面和业务事实；独立交付任务处理断块、转码、租约、发布未知与退款竞争。
- 工作室/详情HLS、按artifact授权刷新、独立下载及严格播放观测；短剧保留原行为。日志接入真实Pino、可信ID与中文场景，规则默认关闭。
- 复用用户指定.env的短剧签名及已有管理Token；本地修复多行私钥格式，不提交任何值。
- TEST13/13上传核验，每条3～5码率、有效分片、匿名拒绝；样本签名下载Range可读。新封面真实上传/upsert/签名回读hash一致，随机测试对象已清理，原封面保留。
- Shared253、Frontend843通过；Backend全量1910通过（本地代理隔离/20秒测试上限），新增及相关25文件209复跑通过，最终真实Pino16复跑通过。全8包typecheck、Frontend/Admin build通过。
- 日志/复杂度/legacy/迁移/DB契约门禁通过；imports原CLI在Windows解析空JSON失败，等价ESLint Node API检查1170文件0错误0警告。现有drive_mode有无关的DB-contract警告。
- 隔离真实PG/WASM验证expand/contract、租约更新、幂等发布/退款、迟到拒绝、未知隔离和ACL；真实13行SQL环境门禁、CAS整笔回滚及重放通过。多连接竞争、真实新生成和真机/P95仍需TEST发布后验证。
- 用户明确不需要本地UI验证，已停止；不把未完成的UI验收写作通过。完整证据见verification.md。

## 拟提交

一个完整变更单元：`feat: migrate plaza video delivery to Cloudflare Stream`，目标分支`feat_video_park`。批准前不暂存/提交；推送也须用户明确授权。不包含另一个未跟踪的video-stream-seed任务、本地.env、媒体备份和私有上传回执。

基础HEAD：`70a876e1cf079ae8a86c5c8c3205b60b70223b55`。

审查源文件共74个；源内容摘要：`df60c8c05fb00ead36a16fde07ab58e1a4b37c7d2986981d82a800fcdd8e3eb9`。

清单自身SHA-256：`d1ddbb3061c282c9994a90f6082a28ca01c6e58aa46b73787758815807074735`。review-manifest.json及本审查页为辅助审查文件，不参与自引用摘要；二者也需人工检查并一同提交。

## 待执行的TEST顺序

提交并推送受审阅文件后，通过Database Migration(environment=test)按delivery扩展→test_assets原子映射→新应用发布/API验证→contract收缩逐文件执行；核验13/13应用行为及受控新生成后才清理原13个MP4。不得按字典序批跑，不自动迁生产。

## 最终文件清单

- modified `.trellis/spec/backend/app/index.md` — SHA-256 `5cc2ac2772fca2953040928c227113c7363223edaa83663017ed80220009cc12`
- added `.trellis/spec/backend/app/video-plaza-stream.md` — SHA-256 `82b592010e8e2fd54ecd5db61f8f2391562e10c8f1ae11bfd39f8914c531ae18`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/check.jsonl` — SHA-256 `f1a9ee8c3b34a9489cc6737412fabe751a25aa88070aee26043e3c599fcda7fe`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/design.md` — SHA-256 `3a267c9584bd19749586af52c8cc92a08ed0678538a10c7667ff9a121344cd9e`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/implement.jsonl` — SHA-256 `f1a9ee8c3b34a9489cc6737412fabe751a25aa88070aee26043e3c599fcda7fe`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/implement.md` — SHA-256 `2ca198354f1baeea4e5f8666778803fb7fabd817dda90efa305cde8451dcefcc`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/module-updates.json` — SHA-256 `8dd7333603fb60b7dfaa02fd148599bea6bd9d5b8762557417f2c99941ea0238`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/prd.md` — SHA-256 `4b3400515cb83e1a2d8c07f49fd4a126dd2c31143164586d0a98418e2edab41b`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/research.md` — SHA-256 `b87c4af84bc768f75b58742ea9c8d323138a9b8f599ae6226fceeeebfbd6fca2`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/task.json` — SHA-256 `55490789b4f61f58149a9a0508827f2ff7321245c29d07f5012244b6cca749ad`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/task.md` — SHA-256 `44dc5558c84720469e055b0c4246d2b34da5ad0547f92327deada15fd79cc13e`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/verification.md` — SHA-256 `bbedbfa95e0c7731165f7c5993335b894e3b9cc7044db5a5e4a90451fd0c38a0`
- modified `README.md` — SHA-256 `a598fa091e28769a8061b21e3fbf5bc7f84b60962b5ef92d6ffb723b7980b41b`
- modified `docs/ARCHITECTURE.md` — SHA-256 `44c1c7151750b850625fe11b3fadfa7983ecd3331c246f214277f6c2d6957137`
- modified `docs/db/registry.yaml` — SHA-256 `2bd969fec9e2f1d036fd8ce8a156a04ff19b4d06082ec5c9383ce11729ba14f1`
- added `docs/video-plaza-stream.md` — SHA-256 `252cf6b85897d942f1c99be238c626d42dafc190305036f2d430108689fa8cda`
- modified `packages/backend/package.json` — SHA-256 `26e0cf1c3f052a16173d6667605b83c50b9f50d3f0b1b654d84684e67627d3a6`
- modified `packages/backend/src/app.ts` — SHA-256 `788d8af566846650be18aaa291a1fb724e3ffd78431dc4ed7a4fbc0d80ecad79`
- modified `packages/backend/src/features/drama/stream.test.ts` — SHA-256 `886c5faa95a118ab3316795d686efcf57d49ea9ad44eac7f37214ccc5fcbaca9`
- modified `packages/backend/src/features/drama/stream.ts` — SHA-256 `9824d5840aa02e3648a3dc50fdc8363152e478b3fe2a2a7317ce03d31c1c9495`
- modified `packages/backend/src/features/image-plaza/repository-model.ts` — SHA-256 `2c3891ab4e0e1dd924a1c925c9459e91553920026fda50f1b0d60e29a9ed8b19`
- modified `packages/backend/src/features/image-plaza/repository-work.ts` — SHA-256 `40297a9497fd17ae4834c7e3074ee642b735cec5c13629339078cfb458835c89`
- modified `packages/backend/src/features/image-plaza/storage.ts` — SHA-256 `35a50c188b744d2a5ebd79ea94d13f9ecff73ecddce0a758d196e6ce553d232a`
- added `packages/backend/src/features/image-plaza/video-artifact-access.ts` — SHA-256 `24b316429919fded80b3cb270b565bed272955902d8a3c564fed2a526311e642`
- added `packages/backend/src/features/image-plaza/video-delivery-job.ts` — SHA-256 `6d4335bc9229b0de2c36213c88ac09430ba7227bc5a8a03f3a7c4e5f562da017`
- added `packages/backend/src/features/image-plaza/video-delivery-repository.ts` — SHA-256 `4b8f27c0a9bcb24ed27fe3ecf194451659d53d4473ed89961c9ccf034f95bbc4`
- modified `packages/backend/src/features/image-plaza/video-job.ts` — SHA-256 `46bdce9359981a379e3776a3636ced1599440aba183197411176ae4f8e16fd5f`
- modified `packages/backend/src/features/image-plaza/video-repository.ts` — SHA-256 `ad756b86231a7041bd2dcf1a840bc207e9df55b31c042b830f550c591b4e0391`
- added `packages/backend/src/features/image-plaza/video-stream-client.ts` — SHA-256 `a4e4f251f7981d532fdcdfca6a5a82311da4f99d0ddf3d9a7e524ce7d3ec6d82`
- added `packages/backend/src/features/image-plaza/video-stream-playback.ts` — SHA-256 `71e93261623ad0bbcd322dcf8c6fcbff7ac5b4f04a770b8528adc28604effe6b`
- added `packages/backend/src/features/image-plaza/video-stream-upload.ts` — SHA-256 `f550fcd1782b8bf4e985876cb01ba5408ec2f05375ab34c0120c3e40dfdcbe94`
- added `packages/backend/src/features/image-plaza/video-stream.test.ts` — SHA-256 `0e575ab9df8824ffcb885866fe8138e0df578dfc8195c9c7be71193a0e53856f`
- modified `packages/backend/src/features/image-plaza/video-worker-repository.ts` — SHA-256 `075cdfdd2dd60a9dc438ae6f7737b2f04ad6ab190e7426d732116363a417843c`
- added `packages/backend/src/lib/stream-signing.ts` — SHA-256 `be3eb7e9248f65564b56f73cbd80c4f3fae2568c7adaaf6bac2f283c86fa4d79`
- modified `packages/backend/src/platform/observability/alert-rules.json` — SHA-256 `a95b15e561b7bf54fd4bb06dd89bd5790cd63c6e851fb27ea30a713d286135fa`
- modified `packages/backend/src/platform/observability/labels.zh-CN.ts` — SHA-256 `90e9ed6519b2ae63415f47924a9cbb5080eee7a50c2f126cd2fea9cd3305aa5d`
- modified `packages/backend/src/platform/observability/logger.test.ts` — SHA-256 `8cb945ec1621d523cbb9d624c40a188a93dde9ed7094082c04a94a31589bf381`
- modified `packages/backend/src/platform/runtime-config.ts` — SHA-256 `c1a5dcbd042b6207fa6c4b345e7c68fd42b3e2ed5e39c011bd5d3027ad2b09a6`
- modified `packages/backend/src/routes/image-plaza-feed.ts` — SHA-256 `49a63422ad032f6fce80d2db164a901f25593f57975d2d23632c785ac0cb4c96`
- modified `packages/backend/src/routes/image-plaza-helpers.ts` — SHA-256 `6a188687a151cb5799639b4e3d8dd51c7fe96add724a4b0bdb05623b1db8acc4`
- added `packages/backend/src/routes/video-plaza-playback.test.ts` — SHA-256 `c9e5f91cec9c610d6dde29cbd5f959f9e45f68da150d69f4f149d17e47f23a1d`
- added `packages/backend/src/routes/video-plaza-playback.ts` — SHA-256 `b391906367315e0d8d5797fca1c921e8c2f8182b161d81823a6ea87c28052553`
- modified `packages/backend/src/routes/video-plaza.ts` — SHA-256 `98fdbd3b1af6e56e857090a97032353c878e499299462a95dc242121853e06a3`
- modified `packages/backend/src/scripts/generate-video-plaza-seed-sql.ts` — SHA-256 `8ffb4cb68bf10f2fd7249232c9b5521e57068be616a3372873bfe1dc21a78e94`
- added `packages/backend/src/scripts/migrate-video-plaza-stream.ts` — SHA-256 `d6109a2704981e8f84467c68001c10dda90ad667a916277533093ef9a0562c59`
- modified `packages/backend/src/scripts/upload-video-plaza-seed-assets.ts` — SHA-256 `8ffb4cb68bf10f2fd7249232c9b5521e57068be616a3372873bfe1dc21a78e94`
- added `packages/backend/src/scripts/video-stream-migration-state.ts` — SHA-256 `766ab8d9e411a4eb26e5fe5313f98b4179e76d7f79625b4cfaab02c080845e06`
- modified `packages/frontend/src/app/(main)/create/work/[workId]/page.tsx` — SHA-256 `73d4bfaa19396766570b4243528c6b9af2ac86c61d5cfd781fe30dc09ed0477f`
- added `packages/frontend/src/components/image-plaza/plaza-video-player.tsx` — SHA-256 `708d4c9f71e98ac57f93e9e442aa55ed1ad1a29f48d0443ea5f04bac99d00426`
- modified `packages/frontend/src/components/image-plaza/studio-video-card.tsx` — SHA-256 `9cab368228fbf7d24ae0ccc0f09a4f1dfca9a860c259aef79cdd9345a6ef123d`
- modified `packages/frontend/src/lib/api/media-cache.test.ts` — SHA-256 `d69d2efe802823eadf8cadf5c9a954865f72ca08ce1b6e0b2176ca07eea30856`
- modified `packages/frontend/src/lib/api/video-plaza.ts` — SHA-256 `f8216b7b3f105c701bc1e45b26241abf15690312c8240cab973a0c4665d006af`
- modified `packages/frontend/src/lib/drama-media-source.ts` — SHA-256 `27199026bb93a715ab0e5543ee3cdca89066aac36160889b0b3d89036357d8c8`
- added `packages/frontend/src/lib/hls-media-source.ts` — SHA-256 `34201fac708a9ea2b28a6c5b53e15a06d2cc40fcae0e7f03b0db5da5f8e2929a`
- added `packages/shared/migrations/20261117_media_plaza_stream_contract.sql` — SHA-256 `e7ca8fa729de07f12b57b545d2ea5d823af9556edf24cc19ac7f0c8642d2d3a5`
- added `packages/shared/migrations/20261117_media_plaza_stream_delivery.sql` — SHA-256 `f9572b32cc8527cd76be44ea1d941ccd7dcb6130141fc5eb9ea4e91c4036b03f`
- added `packages/shared/migrations/20261117_media_plaza_stream_test_assets.sql` — SHA-256 `f805ab8aa7a732585278a03f57df9c0a4cb1d85a952187e5f88b69ca371cb925`
- modified `packages/shared/migrations/README.md` — SHA-256 `e8cb354c61cc2dc7d2343b5a32892fcceea70cd58fd6ed05acd8afcec3e6c607`
- modified `packages/shared/src/__tests__/video-plaza-contracts.test.ts` — SHA-256 `4ad81df4bf9045f8d5579b2f334e25868268613232cf48c943b4ece1bd4c5b89`
- added `packages/shared/src/api/video-playback.ts` — SHA-256 `7700fd61fad24df9ec76575423514d6718c43ad20346ea930e0bd7aa9d5da5c2`
- modified `packages/shared/src/api/video-plaza.ts` — SHA-256 `39752ddb74351d265d693f0f9739696815f597d8424de7810eacee0faa049f9c`
- added `packages/ui-tests/fixtures/assets/plaza-video/0/index.m3u8` — SHA-256 `2b215da92ac713624fa04380d4c906709ed2097ec3312fb45b35eac921634c68`
- added `packages/ui-tests/fixtures/assets/plaza-video/0/segment0.mpegts` — SHA-256 `c23c81598eaad980643c18ab2f2f5ce56f644597e16a894118b247cdbd3615a6`
- added `packages/ui-tests/fixtures/assets/plaza-video/0/segment1.mpegts` — SHA-256 `cc328cf98c6ed8e84ad2ccebe10a39fb5fabc4e38bae2b5cc83675614eea2bda`
- added `packages/ui-tests/fixtures/assets/plaza-video/0/segment2.mpegts` — SHA-256 `23092ed29168bcde898aac31ff209c9eb4475714c8899ca082a337e95c2d7ce0`
- added `packages/ui-tests/fixtures/assets/plaza-video/1/index.m3u8` — SHA-256 `2b215da92ac713624fa04380d4c906709ed2097ec3312fb45b35eac921634c68`
- added `packages/ui-tests/fixtures/assets/plaza-video/1/segment0.mpegts` — SHA-256 `553ffd1883b01edb97f891f4e3ab2000310f7478e3e27e0e96ba154c2fd5c776`
- added `packages/ui-tests/fixtures/assets/plaza-video/1/segment1.mpegts` — SHA-256 `89efca6c52042379b05fafc83550688c3ec7e5b3afe023a2c63e6dc4f01690c2`
- added `packages/ui-tests/fixtures/assets/plaza-video/1/segment2.mpegts` — SHA-256 `f04571efaad5bd39a399aa354d0947c032a78f14417cbb2b660e5fd1d775dcbe`
- added `packages/ui-tests/fixtures/assets/plaza-video/master.m3u8` — SHA-256 `b3ff9824d51415e05d6d94874257659e4c02d4bd2c6d67ffad5774a6fdbbebf4`
- modified `packages/ui-tests/fixtures/data.ts` — SHA-256 `dd24d061edef92b954b990bc837876870bf1c3453afde251b1114e3f11a9428c`
- modified `packages/ui-tests/fixtures/server.ts` — SHA-256 `3813018904982fd3bd4d42a37e371b910d6aac313b96c45fa0eb620c4864bf27`
- modified `scripts/apply-repo-migration.sh` — SHA-256 `065e2bc6cf70b7fcb9a2bb38b22ca3516dbdb9219c29b5c0e7b46bea97d4b493`
- added `scripts/test-video-stream-delivery.mjs` — SHA-256 `a995f9338dd96f3928ee7fecfad0e2d8eaf06ba9253baf8aec40e98c82e0118a`
- added `.trellis/tasks/11-17-video-cloudflare-delivery/review-manifest.json` — 本页所列清单摘要。
- added `.trellis/tasks/11-17-video-cloudflare-delivery/review-packet.md` — 本审查页。
