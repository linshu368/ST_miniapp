# 心愿墙发布复核

用户已经验收本地页面，并明确授权测试通过后上线。本次经 dev 发布，只将心愿墙变更进入 main。

## 本批内容

大厅与创作数据入口、仅匿名公开心愿、支持/撤回、分页排序、公开角色回应、站内通知；最近反馈的匿名说明、示例与底部排序选择全部包含。没有新增奖励/支付/模型调用。

## 验证结果

全包类型检查、前端生产构建通过；最终public-only backend60项、PG17权限与事务回归、创作统计5项、移动端390/320共12项通过。shared235/frontend734前轮通过；远端完整质量门禁继续执行。生产前置结构已只读确认。

## 发布与恢复

迁移文件20261102_character_wishes.sql先测试再生产，随后backend/frontend。它只新增心愿3表及受限函数、扩展通知类型；保留角色发布与VIP通知逻辑。回退应用保留新表，不删除真实心愿，不恢复与新通知不兼容的旧约束。main仅适配导航shell位置及入口，不带入dev未发布的推荐算法。

## 最终口径

只能匿名公开；输入框下明确“心愿将匿名公开，不展示昵称和头像，所有人都能看到。”API与DB拒绝private。用户本轮上线授权与该口径合并执行。

## 提交清单

- `.trellis/spec/backend/app/modules/business/character-lobby.md` — `1da4e526aa4e8370f0b1e57d3204ad73bcf5e84134f846a48665daeb72ec6530`
- `.trellis/spec/frontend/app/modules/business/character-lobby.md` — `631e821d9511814c62d54dd8f4e7058ec5b5a6831402a0a44e86e3b5dd4dc8b6`
- `.trellis/spec/shared/contracts/modules/business/character-lobby-contracts.md` — `340ddaca5e15f59721591f96c4d76a7dc5f337295402b621eb4f830dc0ec872d`
- `.trellis/tasks/11-02-character-wishlist/check.jsonl` — `73aa034936ca5cf9cc0086b398f6154adb9687903b47485e4d0f82082183ab40`
- `.trellis/tasks/11-02-character-wishlist/design.md` — `bee89cdcfc685ea45664e0059a43026e77e0dc7b48bed0d0ae26f7bc853c99bc`
- `.trellis/tasks/11-02-character-wishlist/implement.jsonl` — `73aa034936ca5cf9cc0086b398f6154adb9687903b47485e4d0f82082183ab40`
- `.trellis/tasks/11-02-character-wishlist/implement.md` — `96f1804dd06e0bb5790d5116552ff7a03827e765d6633172305b3ab7d7d9a479`
- `.trellis/tasks/11-02-character-wishlist/module-updates.json` — `1d70b1ff8a9782e1a3f3b702d865c0bc0ff449d28bab44eaa873845665a593cc`
- `.trellis/tasks/11-02-character-wishlist/prd.md` — `0efd169394bcea052a7e52c19fd9750fe5e4705d6523b347abd9e558b4016f7d`
- `.trellis/tasks/11-02-character-wishlist/task.json` — `5989b21ce0f82a4e4616917cef207309e92109240ebff7a132d24d23bdf6437b`
- `.trellis/tasks/11-02-character-wishlist/task.md` — `f4066db035ce3884805fbe5f1a8804319671d359e49ceb3922869ec97f485bd9`
- `.trellis/tasks/11-02-character-wishlist/verification.md` — `e9d09ccb98c4158bd469f4dc35308ca22134387586c2a8b2703acc38910b64c3`
- `README.md` — `3f3ccc6004c44758c3b4209509666ed34963cd7cdbd41b34babe32a954cab456`
- `docs/ARCHITECTURE.md` — `7e7b8a178669dc390cc3e824fa86f495ef7a573e7d3d992b521f1b3a30c7a49d`
- `packages/backend/src/app.ts` — `0df609d04bf8b88940c260e2d1175ca12a7445dffc4a335d098c25c947ba1f16`
- `packages/backend/src/features/character-wishes/repository.ts` — `714731c045014f989b00274b137d59fcfffb200a6dfc8dc91241132cd4afe070`
- `packages/backend/src/routes/character-wishes.test.ts` — `e3cf95d413ebc0d9373c261f050391ac1c93a8b5ed81be9b0d759bbeb10be5c8`
- `packages/backend/src/routes/character-wishes.ts` — `9bfe7b58a00c999a015faa97524ca2192973b3298d649f4a50cdad6eb6010928`
- `packages/backend/src/routes/creator-characters.test.ts` — `75d1dfa6b7b5988de7eef52af5cab76ea13e0c2bf49714bd27eae8deb417a151`
- `packages/backend/src/routes/creator-characters.ts` — `adf5e693e8c646f95f4f9688caadcadfdfff97d7021de9faab36328ea6c238b6`
- `packages/backend/src/routes/notifications.test.ts` — `53b2ba15e98c61941c8ecf14a89db435f0c0cbc18fe84d01a16904398a398bf0`
- `packages/backend/src/routes/notifications.ts` — `a1944428275a72bae8391776b7fe5b32ff790ccf6d097231e2e9d9e8e189e05a`
- `packages/frontend/src/app/(main)/profile/messages/[id]/page.tsx` — `c8066b94e60fd33d7af713acf618e8f20e4eb64d1e0eeda81cb70f45568fb5e4`
- `packages/frontend/src/app/(main)/wishes/[id]/page.tsx` — `53b43d17696805a082414c5d5a03020e51947365b4ebf60819fe90d63322634c`
- `packages/frontend/src/app/(main)/wishes/page.tsx` — `6aba9647a27c25028f0839cb47c99abc3e698fad1714d922dec96196164c7bed`
- `packages/frontend/src/components/characters/character-gallery.tsx` — `a8f9223b8d3edb20d6127d14702ca01dded3087365876460641991d7b4c97c11`
- `packages/frontend/src/components/creation/character-editor-draft.ts` — `a0721ba6e2698d2a6f0578971a68389fd8e8f36136ca2a0389f17a2bad741176`
- `packages/frontend/src/components/creation/character-editor.test.ts` — `3790fece8dd3e0841482f3560cfd7bf7a1e96594bbc29310cd5d537af6e38b8c`
- `packages/frontend/src/components/creation/character-editor.tsx` — `d9c6940737a509274ca84ddc7ef13a7e3aeba9cd83bbe4eb68a1ad53f3fd443e`
- `packages/frontend/src/components/creation/character-wishes.tsx` — `a6a29a405aed2a6fb9da9d1a7a13bc771b3d31133f578ef30c3801ac96758ccc`
- `packages/frontend/src/components/creation/created-characters.tsx` — `cb0dbb1478c2a4c2d47d5084c619c7a5903c4a1acad747e4cd5cc60f24355b13`
- `packages/frontend/src/components/creation/creator-analytics.tsx` — `9318444d4cedb03aff65b60e20a9e193acb64bd48f7b1703b002f8c9d654d4fe`
- `packages/frontend/src/components/nav/bottom-nav.tsx` — `c079d90f5237fdcce878ebc091cce2712fa5a8d7cb853eb7fcded80da033d8bc`
- `packages/frontend/src/lib/api/character-wishes.ts` — `02970f856506ef9e92da62314646e4349567fd9c5aacd132cb6d1092f4084c1b`
- `packages/frontend/src/lib/utils/notifications.test.ts` — `2af1aeb94eb8102c5a4422ae8d155310ec2e64b54fc084e0b33bcca1f7e80fa7`
- `packages/frontend/src/lib/utils/notifications.ts` — `5a70cfb298578b48465a8db2d84820a92242cc2add0e3491a7e0510ee229bcbe`
- `packages/frontend/src/lib/vip/presentation.ts` — `57148706b4982d83246e15f8dd64b31066b10c1ab03d6723281e23c08db9f0f4`
- `packages/shared/migrations/20261102_character_wishes.sql` — `e65e46e73b71d969830b5003fb14e1b069657f9ca7359228495cdd90fe065b8e`
- `packages/shared/migrations/tests/character_wishes.sql` — `f2daca8e5ef0c03e130af220237417d6cd00b46f25026662c5ebc2a099033155`
- `packages/shared/src/__tests__/creator-tools-contracts.test.ts` — `6acb35ab29e98d2aaf41972b6f9f41d331a242bf4352f708338e6cd778d46dcd`
- `packages/shared/src/api/character-wishes.ts` — `a33a13495f67e03ce527ae63da6b5ecb61945c002e0423e5d795a6f0ddd0f565`
- `packages/shared/src/api/creator-characters.ts` — `06e48226b8bf212861ffb6134daf3e2b80cbc0be272cbd117b659a047cfba3e0`
- `packages/shared/src/api/notifications.ts` — `62d8e38cc939c94fa73326f8511ac731221a4177c775738387f508e3996b08e1`
- `packages/shared/src/index.ts` — `9b35e45ba5ea900f4a23cab6d8773b28d92e6daa17de992369bc91dbb30fb500`
- `packages/ui-tests/README.md` — `fca636b7cb921e4a99fe982b192ce5a0f58d3ece83fb03a24840ab7f2216eb8c`
- `packages/ui-tests/fixtures/data.ts` — `ac65f226dc124f68943537e0175683edebb7a22daf7eb8b5243c3bef0a5773c4`
- `packages/ui-tests/fixtures/server.test.ts` — `3617d9eb3a9a25ca1e3df423b2b7361e32a9b0ca1ba852a12c4d45dbf2159848`
- `packages/ui-tests/fixtures/server.ts` — `afdf03d50f2e2b8cc1bbc312a38bd55bf54b97a6d09b7f83e08a299aaaabdd03`
- `packages/ui-tests/tests/creator.spec.ts` — `0017c04dc6817377a3996a568812838e5170a969bf06c0eddf705babac920e11`
- `scripts/test-creator-characters-local.sh` — `80da1b980437410d8977fb4f8180310f37228213536bc25bfc94ca2a8b789d64`
