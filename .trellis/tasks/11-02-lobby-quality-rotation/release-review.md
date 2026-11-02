# 推荐评分与24小时轮换发布清单

用户已确认本地效果并授权上线；范围仅本次新人评分校准、前12张轮换及配套配置/迁移/复用验收。保留最新main全部上游内容，不发布dev其他差异。

验证：全包typecheck/lint与静态门禁通过；固定评分轮换85通过、1可选容量跳过；移动端完整大厅23通过。上一阶段Backend/Frontend/Shared/Admin全量测试与构建通过，当前最终提交由远端CI复验。

拟提交：feat: rotate quality lobby recommendations every 24 hours

发布：TEST单文件迁移→dev验收→production单文件迁移→独立main发布→确认新评分job成功且旧writer已退出→保留运营既有参数、仅启用rotation 24h/2重复/2探索/10%。回退关闭rotation，保留兼容表和历史证据。

## 文件与SHA256

- `.trellis/spec/admin/app/modules/business/operations.md` — `fcd9630e8b51edb977b369f093b247969762f45d81db5bbe5828c7dac88d00ec`
- `.trellis/spec/backend/app/modules/business/character-lobby.md` — `048f99a7d1874cb1582249391db22414665da2b96ef8babc43ea8a7e19764c62`
- `.trellis/spec/database/supabase/modules/infrastructure/schema-security.md` — `6a789e035e70ef5ef181712e2868172b8615d2da1a522903dddb0614da5b3781`
- `.trellis/spec/frontend/app/modules/business/character-lobby.md` — `dc7b999310935e2cb570037c70c9662c963c0659a602432f90ec41b583d1a0c6`
- `.trellis/spec/shared/contracts/modules/business/character-lobby-contracts.md` — `46e4a677dc5bca30c8460893111e5da2694f314d3caa02fa9ad7aaee11c2cfa9`
- `.trellis/tasks/11-02-lobby-quality-rotation/check.jsonl` — `6aaf063a71db7629610b4c4fbc1b66d48d723c1478bd30ceac6b8c22d17582e4`
- `.trellis/tasks/11-02-lobby-quality-rotation/design.md` — `b2caa650cd3c6b3ded47a279522603105a4cbae17db019a1d9edb2f666f82b3b`
- `.trellis/tasks/11-02-lobby-quality-rotation/implement.jsonl` — `6aaf063a71db7629610b4c4fbc1b66d48d723c1478bd30ceac6b8c22d17582e4`
- `.trellis/tasks/11-02-lobby-quality-rotation/implement.md` — `d9d0a64f5604775c0a3c1c224fc4b6ab4d453f7cf6fd8a69fb5b4f72c29c88b0`
- `.trellis/tasks/11-02-lobby-quality-rotation/module-updates.json` — `be39a9bff357168cbb7b75c62f5ad3ca0ed87327e7b67f3667de11525d394a76`
- `.trellis/tasks/11-02-lobby-quality-rotation/prd.md` — `a022841dd1ed15da99865549a2333a9d734f082131331fefe9a1a55b3e820502`
- `.trellis/tasks/11-02-lobby-quality-rotation/task.json` — `415b51b6b9fa9be22d5a3987b71501a81b855dff843a9ef78cfebb75e2019bd5`
- `.trellis/tasks/11-02-lobby-quality-rotation/task.md` — `5c3382bff45ef42fccdc5816aa02181902cbd7bcc4e500fc7695ee3ab92919dd`
- `.trellis/tasks/11-02-lobby-quality-rotation/validation.md` — `2eca01adceb55d35e9810a2a927c1719f0167d11ae0e3e9ef3eb3d3480b47e27`
- `.trellis/tasks/11-02-lobby-score-qualified-users/check.jsonl` — `6bae9e481acc0c4e4b33eed57355e31c753799b987fdd2782c37bb29d6a4c1fc`
- `.trellis/tasks/11-02-lobby-score-qualified-users/design.md` — `5a17c47c063463dfc2ee7fd45439362fa7dc25097adf8a49ba83a1b8cb875acf`
- `.trellis/tasks/11-02-lobby-score-qualified-users/implement.jsonl` — `6bae9e481acc0c4e4b33eed57355e31c753799b987fdd2782c37bb29d6a4c1fc`
- `.trellis/tasks/11-02-lobby-score-qualified-users/implement.md` — `2560bf92b89e5eab6a5e0c1692da87f640bec2bba53b50d924ed8220b163df7e`
- `.trellis/tasks/11-02-lobby-score-qualified-users/module-updates.json` — `001c2b05914781a42592d594a9ca8ca3df776665e9935d3b92126aee2d217d55`
- `.trellis/tasks/11-02-lobby-score-qualified-users/prd.md` — `2417bb4a49fbb3313b89d0a90ecb74943d73ef511d7c19232c74a4ca00768adf`
- `.trellis/tasks/11-02-lobby-score-qualified-users/task.json` — `850f0a7fc7f075c4e4ddde7a103dd4f25a9a0a1de1d39a5798bb03e680f53a5c`
- `.trellis/tasks/11-02-lobby-score-qualified-users/task.md` — `0968efeb5f653e0a60d8a9a9b425bf58f424d73095425a0894b7c92ac989aa94`
- `.trellis/tasks/11-02-lobby-score-qualified-users/validation.md` — `443489bd71c3d26e14051232ed601e1281af9d747f2168f08d158f38a3a69796`
- `README.md` — `24b7215d2125ff0edc2d77dd3083050f4aa93fc55de6e0289e94565bd459a8df`
- `docs/ARCHITECTURE.md` — `452e80a7792d7962cff4abf57de542779d257a688d7eedc6c3d527f1b79d805f`
- `package.json` — `4ec1261f7fbaab330bb0e1b9b070536dc3ceca7ee3d2190163d8c69b57218dc8`
- `packages/admin/src/components/LobbyPinnedCharactersEditor.tsx` — `2dae1629e20e0163466c6facab1726cc10ec9fc43f29cc1fe8bcae7046f74d69`
- `packages/admin/src/components/LobbyRankingParamsEditor.tsx` — `7a8b8590089d696be898b358b875fe1ffa71cef8594b7df9e2d6b8629adad5b1`
- `packages/admin/src/lib/configSchemas.test.ts` — `81f4f723d9664627a77c12f4b4045d8432f65a65c27f71e4300e0b9f81ce9c08`
- `packages/admin/src/lib/configSchemas.ts` — `1bcbec21ed9d86b71d0bd42724ca890547377c7ae1d121123a812ddd62447d31`
- `packages/backend/package.json` — `2cf496887fa69c8ed01080fc63f15c14da1b3b873e11263c8e308ff0aa2f88af`
- `packages/backend/src/app.ts` — `989c05fe7d45e91357ba2df8c48fd499a2c0f272705d39d1adefec7c509a72df`
- `packages/backend/src/features/lobby/featured.ts` — `f79cb4d0ee736b87442e272070d90fc9017073e0c6a64baf60228de6ab45a86b`
- `packages/backend/src/features/lobby/pinned-characters.ts` — `b770e2fae5e762306e68aa3e76aa7d40fb8e4cb0a4644558550857abc3334387`
- `packages/backend/src/features/lobby/ranking-score.ts` — `bd8c80b5b5843fa0ef81f93d9475d3fda3668c311d5dc2ec35c53ba7e9cf05ab`
- `packages/backend/src/features/lobby/ranking-stats.integration.test.ts` — `b90c40c88a0c0720388767a9ce53638bde6950b580931c2ca0fbf543b79c281f`
- `packages/backend/src/features/lobby/ranking-stats.ts` — `bc6900a7aade087429ccef9c6d9c474a55a315879f766d6710ce39d493d432c1`
- `packages/backend/src/features/lobby/recommendation-ranking.test.ts` — `2f2b7b761acbb2a49a55f2c923f2ffa1dc4cedf965fcb9eff54f9cc2836ca8cb`
- `packages/backend/src/features/lobby/recommendation-ranking.ts` — `e4f36941520239c7162fdfaaf5908c487338b8525b398226312e356d3575a58b`
- `packages/backend/src/features/lobby/recommendation-repository.ts` — `5b8f92f697c20a24b1a1103fdb87cf3201d15122ab63184b493f098078aeffed`
- `packages/backend/src/features/lobby/recommendation.ts` — `9e09693a5fd7b2b0bbb39cd281d258dde23aa8c6426606017287571a770ec96e`
- `packages/backend/src/lib/lobby-ranking-refresh-job.ts` — `8e56ffa76ddd88b70cb2c910f95f82bc6d4afdcb566c1661172d230fbd269fdd`
- `packages/backend/src/routes/lobby-recommendation.test.ts` — `9918d4e4e89b94ef1ab60aa2f5514765fa6a87e9ea8568e59ea1e24724eb9ca6`
- `packages/backend/src/routes/lobby-recommendation.ts` — `bfb7ba54e934ffeb6fc902e0427c830fbebb491662eb9cb3c8f80d8eb315ff75`
- `packages/frontend/src/components/characters/character-gallery.tsx` — `ea63eb7b74ef4b383716f8196be7d38fe4ddee571d088e51a7189a654dc4a66b`
- `packages/frontend/src/components/characters/use-lobby-exposures.ts` — `a426bc8a8b4ab60dd627976001f0da04037914c5007abf2fec8a0cfd79568637`
- `packages/frontend/src/lib/api/lobby-recommendations.ts` — `9da6fcc321bd7808972b25446d6b53baf100e542d72f513b1cb88f60c63e0c6b`
- `packages/frontend/src/lib/lobby-recommendation-state.test.ts` — `aef5bcfb413ec8076e5f804e53cd87d694277eca2a79e01ec8d45bc4904e51c0`
- `packages/frontend/src/lib/lobby-recommendation-state.ts` — `505b1fdc18cc4b92d90ca12ac82cd035f1c5c775fe043bc161004ec9e6dce2a5`
- `packages/frontend/src/lib/lobby-return.ts` — `4e792509b6e0d508f25e42554a725e352c3d43d1a3471ba1a7cdd279fcb0c82b`
- `packages/frontend/src/lib/roleplay-navigation.ts` — `a78f096f972e2bb6f9c7211459ab9a13bc987557568f1bb388e2e910c483b60c`
- `packages/shared/migrations/20261102_lobby_quality_rotation.sql` — `513072fab7db92e27492786442128bd87b164d35e20fd346b7510cc46272677c`
- `packages/shared/migrations/README.md` — `f155eef5054f79c74583bf4ca5e3f917fd90a71f8a2e3c6006008ae8b11c9303`
- `packages/shared/src/api/characters.ts` — `10964f03e05d6a26c08e9e441e05134d69e30f2d164ce985f56a16ea7a4c2f0d`
- `packages/shared/src/api/lobby-pinned-characters.ts` — `ceeb4321abd5e4471dc6fa5260953bd004f6c7c1dca5ae8fd45df395e9bc55c2`
- `packages/shared/src/api/lobby-ranking-params.ts` — `6a21223a16b034f4a6da826a9bc6fafe1f4bf574093447a3fa3e30734a81c2b0`
- `packages/shared/src/api/lobby-recommendation.ts` — `a2992a0822302184b22c42598d13acf54863b8fa07362f42d80a2a7859895a91`
- `packages/shared/src/index.ts` — `61dd3d1530fd8b625f76af05ff59ca50b6fa10656b3cf6835995c0af940f8ae6`
- `packages/ui-tests/README.md` — `4077072a184ea0db749907504bfa1c3f3af22cf8fada110b34f45a85bf7bed06`
- `packages/ui-tests/fixtures/data.ts` — `d9c71a8f86cd3cdbfbe2142ad095aac9a143b39a1270136bec1b7261cb41d9f5`
- `packages/ui-tests/fixtures/server.test.ts` — `5442d6d19c6a8f931f2f30cc1aa37f12a2fb3f797656f9f3e629aa3eca2afd2c`
- `packages/ui-tests/fixtures/server.ts` — `a3c7535ca6fd63e80b1ba14bdbdac95de052d4d61d5516230f6e055848be435d`
- `packages/ui-tests/tests/fixtures.ts` — `3463767b38e2c951aacd04accac65444f9e928f845cf7c6590569ec60ee0e51b`
- `packages/ui-tests/tests/roleplay.spec.ts` — `29650b8eb0f7e59986688dc9e84f6ccd639a9d1fb3d4ce97716e27411066bbc7`

本清单自身一并提交；未识别的无关改动：无。远端结果续记于发布说明，不将尚未部署描述成已上线。
