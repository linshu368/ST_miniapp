# 聊天编辑删除与会话整理：发布审阅

用户已在本地验收后授权上线。当前基于最新 main `51d5b2af`，使用 `codex/chat-message-edit-delete` 先合 dev 验收，再以同一功能提交独立合入 main；绝不整包发布 dev。

## 本批内容

- 最近十轮单条编辑/删除，一问一答一轮，只删选中消息，保留后续；双方可改，角色只改正文，附加模块由服务端保留。
- 底部更多收纳低频分支/删除及用户编辑；角色编辑独立入口；同角色抽屉区分日期、自定义名称、当前和分支来源。
- 唯一迁移 `20261102_chat_message_overrides.sql`：会话局部覆盖，不改原生成/计费事实。TEST成功后生产，再Backend/Frontend；已有覆盖不能回滚成旧投影。
- 复用本地固定验收；creator/drama/roleplay等测试文件仅将硬编码本地端口改为统一可配置端口，避免串用其他窗口服务，无产品变更。

## 验证

对齐最新main后：6包typecheck、Backend相关99项、Frontend全量720项、手机固定场景13项通过。Shared218项、PG17迁移重放/十轮边界/权限/并发/分支隔离及Frontend生产构建已通过。独立审查无P0/P1。两库前置21列视图、函数补丁锚点、ACL一致，新表尚不存在。远端CI、TEST/生产迁移和部署结果待发布流程记录。

## 最终文件清单及SHA-256

拟提交 `feat(chat): support recent message edits and clearer session management`。下列文件均属于本轮已确认功能；本审阅文件一并提交。

| 文件                                                                                        | SHA-256                                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.trellis/spec/backend/app/modules/business/conversation-generation.md`                     | `71002ab7276608125996d674c97c4cf3c486b2cec90e835e11184501bc3df688` |
| `.trellis/spec/database/supabase/modules/business/conversation-storage.md`                  | `effbd493f1d22a06c45bd1ef403e0c3bc9ced4009ea374d0e087614e04ff2bce` |
| `.trellis/spec/frontend/app/modules/business/conversation-ui.md`                            | `1d2db3ebcf3df79531f4b16d31f844ef8518ea4994b260c3286ae7fa921292b9` |
| `.trellis/spec/shared/contracts/modules/business/conversation-contracts.md`                 | `d62d2f3e58303c39f3a96e3881b0e20f67d041ee7b83b0848ea6c21e441bbf94` |
| `.trellis/tasks/11-02-chat-message-edit-delete/check.jsonl`                                 | `4e2133869c0bd76fb705f40baf86104dd879c81aa35a312e27345e0970c631fb` |
| `.trellis/tasks/11-02-chat-message-edit-delete/design.md`                                   | `c81895e4e3487480992b5e865fb75d44e3d54ba62ad6add10c98c80070109782` |
| `.trellis/tasks/11-02-chat-message-edit-delete/implement.jsonl`                             | `4e2133869c0bd76fb705f40baf86104dd879c81aa35a312e27345e0970c631fb` |
| `.trellis/tasks/11-02-chat-message-edit-delete/implement.md`                                | `5e04f5b12d25adeda279e1e103823f52b54b1398798ce782bf944977109f3123` |
| `.trellis/tasks/11-02-chat-message-edit-delete/module-updates.json`                         | `ddc2750881e22cfb854acbbfc48eb27421ea9a1c6d3acbfbac38140dce3395a1` |
| `.trellis/tasks/11-02-chat-message-edit-delete/prd.md`                                      | `3972e75ac473cb8cc4690564ff94fc7699201d7c1f264d7d3cf5da776685a286` |
| `.trellis/tasks/11-02-chat-message-edit-delete/task.json`                                   | `8a4caf337c0ee676607e2ba2fb2281372dedbbe939d2f69cb6fda1016758fd18` |
| `.trellis/tasks/11-02-chat-message-edit-delete/task.md`                                     | `8d8a981b3f8a380c86fd8ee41cb7762395323bdbfa5dff0075a8227013b501cc` |
| `.trellis/tasks/11-02-chat-message-edit-delete/validation.md`                               | `dc93cb45c980afe226a596e273ea35da9c3f7f4ec6f82664bc3c49333205410f` |
| `README.md`                                                                                 | `245c80637f41287aa79e7138ee9241d1547af825581a4011d5ff01778bb575d3` |
| `docs/ARCHITECTURE.md`                                                                      | `d1ffa2c48cf86dfceabd71df150577b317d63fa69423a8f7f001006f6918ecec` |
| `packages/backend/src/features/conversations/errors.test.ts`                                | `c1a7281ae5bdece380aa03de86b8dc365d0d9b47df236a521b0e3226b4a33835` |
| `packages/backend/src/features/conversations/errors.ts`                                     | `a4c6a6be86eacf6c3c5fb58d87877e5434320a96cc465ff868f76a9f847a2922` |
| `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts`         | `89cfb9dc582a4f2fc1d3df8fba76340769c702dad977bb68fded63b4a5e57a96` |
| `packages/backend/src/infrastructure/repositories/conversation-errors.ts`                   | `618fb67f1b9ff7cd63b30e2f052e1e635930c54cd47314f79ea308b60604422b` |
| `packages/backend/src/infrastructure/repositories/conversation-history-postprocess.test.ts` | `b287671b3771d9559b991a8d02b8ef6f75d139f2de72d4c6e3abef6f856afd91` |
| `packages/backend/src/routes/conversations-branch.test.ts`                                  | `08884e26cf45081ff1251e4de2dd76d8df726cfe32225372597076d4ae90ddeb` |
| `packages/backend/src/routes/conversations.ts`                                              | `a4b0d3875070421290af01b5d9232884c604083b7eb3a3fd3f85e348923fed78` |
| `packages/frontend/src/app/chat/[characterId]/page.tsx`                                     | `6abf0fe9e4ec5c00fc073cbed4fd62f89c96a84809ca49ec500dfeae86cf3844` |
| `packages/frontend/src/components/chat/chat-branch-button.tsx`                              | `DELETED`                                                          |
| `packages/frontend/src/components/chat/chat-message-bubble.tsx`                             | `3065aa7a194b8112e927f4c8bcaa58f14f2c9e92a4bd5783d8b6fc8a84208ce4` |
| `packages/frontend/src/components/chat/chat-message-editing.tsx`                            | `59fe36f457abb98fd355042ff8d169912e000f2c2db09c56f68ecdd2cd4ee837` |
| `packages/frontend/src/components/chat/chat-message-list.tsx`                               | `d0e107c40fe6a2cef5bdbe902bc9f06a42a602bc796099267a5088617702ebc9` |
| `packages/frontend/src/components/chat/chat-message-voice.tsx`                              | `191ed20f81bcef132fbf941580fee21e848f4a06b5496b1fa93af2aa47197827` |
| `packages/frontend/src/components/chat/chat-session-drawer.tsx`                             | `7e884e2651273444bc7f097b177133ffc5e99e9d9ea1f8d165155b37280853ea` |
| `packages/frontend/src/components/chat/session-row-actions.tsx`                             | `61539ce847193317eb7bb8bc0a97f0f0d102b557e07fdab50c5ea72ca935b2c7` |
| `packages/frontend/src/hooks/use-conversation-turn.ts`                                      | `588da0b1dacf25f71ac18884894d8e7ea0fcffe1ee91401ec65c91af6f82e944` |
| `packages/frontend/src/lib/api/conversations.ts`                                            | `adf28a6b1f97979a8127b6894c7e328534795c1d3f9b611cd7224e40c064c0de` |
| `packages/frontend/src/lib/merge-streaming-messages.test.ts`                                | `3f9bff2fc0c26fb348e92448b4d8e73f32db5f2407d07ef9861da97d5a44ef9d` |
| `packages/frontend/src/lib/merge-streaming-messages.ts`                                     | `fb1a0d605bfab0f63fa7e087afbd4ca0efe154ea98fe33dbd71df58ba677b77a` |
| `packages/frontend/src/lib/text-postprocess/artifact-renderer.test.tsx`                     | `2808f3cf2c62d3dad64cb61e1fe653dacfe86503a5b78d3040c84b37cf0a178d` |
| `packages/shared/migrations/20261102_chat_message_overrides.sql`                            | `96feefbce6ac7225da8420887e8bc762362eea51dea04f1abddb174883aacfe7` |
| `packages/shared/migrations/README.md`                                                      | `29ab26483a0dd49893fec0a75ad7a0d43f7ac6f6e438e293d140aa53ca9fe2b8` |
| `packages/shared/migrations/tests/chat_message_overrides.sql`                               | `ef03a702fd8891b638de55b09831ce92f718b22098e7d42fe87ca9582e08f7be` |
| `packages/shared/src/__tests__/text-postprocess.test.ts`                                    | `bcca36d60154e1ef62b3b967d8e8a67daa4e5ce6bb0a6bb29160c03714dfde41` |
| `packages/shared/src/api/conversations.ts`                                                  | `81cde975d230088a700cc50490812308a2fdfd544bad99585ed618d7b8178251` |
| `packages/shared/src/rich-reply-protocol.ts`                                                | `cec3c737e970ce84f7647e1ac6bcf732c520c8e2525e07f346756486dce4c1da` |
| `packages/ui-tests/README.md`                                                               | `5b3c4a1bac10b45bf13cbdc9b0b4a8a169660eefa57a0ca95e5be5a6fbd5276d` |
| `packages/ui-tests/fixtures/data.ts`                                                        | `098efec0039a4750a21e9c171e982fe2d9586cf3df2afce572c5881c39f2a97f` |
| `packages/ui-tests/fixtures/server.ts`                                                      | `b2bf641224b8cc305eda5d7038782059ff46ffff7d3364716536a317bd728c80` |
| `packages/ui-tests/playwright.config.ts`                                                    | `746b45926086b8883396cf20684fa0b6375c2b1a1dada1931c4ee3a27e9838cb` |
| `packages/ui-tests/preview.mjs`                                                             | `7b4b6048fad0f8329c11e6242c75b72308b70117deb3660aacebc0fbc0d456a6` |
| `packages/ui-tests/tests/chat.spec.ts`                                                      | `ca815228d04c42da643b3aa5133a2c8bd3ade7cc81e59e8d2d86c9a8b8b511ca` |
| `packages/ui-tests/tests/creator.spec.ts`                                                   | `f337c0e30e916d298bf8520e741c43cdaa3f5d5f9588d03db22f909b6ab72bf8` |
| `packages/ui-tests/tests/drama.spec.ts`                                                     | `d026efaf8da3dcbe12dd047db4f2e1ccbede6c9bbb11445957bc63baeeaa137e` |
| `packages/ui-tests/tests/fixtures.ts`                                                       | `a9bcb187ae65016f8c738be5efa45847ded11da832b0605dd005dd89394e9fab` |
| `packages/ui-tests/tests/preview.spec.ts`                                                   | `edc8ffa3b75365eba62737cd299b4bdbeb26064c12015bce1970a258536fa993` |
| `packages/ui-tests/tests/roleplay.spec.ts`                                                  | `ba64d6a27bdda7a1b174fb8331adad1c3e132e4135fdd71d5fdb094bc4c4ea1e` |
| `scripts/test-conversation-branches-migration.sh`                                           | `9a04fb746d13f4b8e34f9fbd824ea2a9f9e3c182711feb9938bc73baf2ba7123` |

## CI全量回归适配

远端全量检查发现取消测试fixture缺少真实session_chat_history已有的is_inherited=false，使mock过滤结果为空。仅补齐该标记，产品代码、取消/收费逻辑和原断言均不改变；独立审查确认后，全量Backend1160项通过。追加提交仅含本段审阅记录和以下测试文件。

- `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.cancel.test.ts` SHA-256: `f299a0e33e534ca57a2d86d832ebf89688c6fcdf5f8e92177d238a5c2f311379`

TEST迁移工作流41392740903已成功，25列投影/函数保护/权限与迁移checksum回读一致，PR588环境health正常；生产尚未升级。
