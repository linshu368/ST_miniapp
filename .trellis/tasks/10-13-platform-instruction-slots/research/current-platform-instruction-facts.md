# Current Platform Instruction Facts

## Evidence baseline

- Code baseline: `origin/dev@cf1569e7`, fetched 2026-10-13.
- Requirement attachment: `/Users/qj/Downloads/V1 _1012.md`.
- Feishu links for the new body/status/memory copy require login in the available browser, so their exact text is not yet verified.
- No remote Supabase business data or configuration was read during planning.

## Current code flow

- `system_instructions`, `interaction_mode_blocks`, and `pref_word_count_tiers` are read through `packages/backend/src/platform/runtime-config.ts` by `features/engine/platform-instructions.ts`.
- `render-instructions.ts` currently replaces `WORD_COUNT`, `INTERACTION_MODE`, and `USER_CUSTOM_INSTRUCTIONS`.
- `pref_show_options` is the only current output-module toggle. It is stored in `app_core.miniapp_user_settings`, exposed through Shared DTOs and edited by Frontend generation preferences.
- `runConversationTurn` opens/persists a logical turn before building the prompt. Regeneration retains `turn_index` and increments revision.
- Conversation context uses persisted `user_input` and `assistant_reply`; prior rendered platform instruction blocks are not replayed as historical user messages.
- Admin manages `system_instructions` as text managed-config and `pref_word_count_tiers` as JSONB. `interaction_mode_blocks` is not an Admin managed key.
- Admin managed-config writes use the existing Supabase draft/publish/release/rollback path with TEST/Production-separated clients and confirmation behavior.

## Existing reusable code

- Backend: `features/engine/*`, `MiniappUserSettingsRepository`, conversation start RPC wrappers, `runtime-config.ts`.
- Shared: `api/settings.ts`, `api/conversations.ts`, public word-count configuration.
- Frontend: `ChatGenerationSettings`, generation-config React Query hooks, existing Switch component.
- Admin: `SystemInstructionsEditor`, `ConfigValueEditor`, `configEditorCard`, image-config tab layout, managed-config helpers.
- Database: `app_core.runtime_config`, `app_core.miniapp_user_settings`, `experience.chat_history`, Admin config draft/release tables and validator chain.

## Gaps requiring live verification

- TEST and Production may not have identical migrations or published text-postprocess versions.
- Repository starter samples include `[status]...[/status]` and an older choice form, while the requirement specifies `[choice]...[/choice]`; neither proves current live behavior.
- Before implementation, inspect only the published configuration metadata/source needed to establish the exact three tag protocols in each environment, without exporting business rows.
