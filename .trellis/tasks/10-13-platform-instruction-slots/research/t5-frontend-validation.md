# T5 Frontend generation preferences validation — 2026-10-13

## Scope and dependency

T5 changes only `packages/frontend`. `ChatGenerationSettings` keeps the existing
`useGenerationConfigQuery` and `usePatchGenerationConfigMutation` route: it reads
the server-owned `config` and sends one optional preference field per switch.
The existing mutation replaces the React Query cache only with the successful
server response, so it does not create a second cache or client-side source of
truth.

The component adds the user-visible `pref_show_status` and `pref_show_memory`
switches beside `pref_show_options`. Missing values are rendered as enabled,
matching the T3 Shared/Backend public-read fallback. It does not receive,
derive, show, or log remaining-window counts or `full` / `concise` / `off`
modes. A pending mutation disables the existing controls, preventing a repeated
save; after an error the controls are enabled again and an inline error gives a
recoverable retry path.

## Local validation

Run from `/Users/qj/python_project/ST_miniAPP_platform_instruction_slots`:

- `pnpm --filter @miniapp/frontend typecheck` — passed.
- `pnpm --filter @miniapp/frontend test` — passed: 38 files / 245 tests.
  The focused `chat-generation-settings.test.ts` covers explicit on/off and
  the missing-value-to-enabled fallback.
- `pnpm --filter @miniapp/frontend lint` — passed with no warnings or errors.
- `pnpm --filter @miniapp/frontend build` — passed. Build emitted the existing
  Browserslist data-staleness advisory only.
- `pnpm --filter @miniapp/shared typecheck` — passed (DTO producer check).
- `pnpm --filter @miniapp/backend typecheck` — passed (generation-config API
  consumer check).

## Repeatable manual matrix (environment verification pending)

Use an authenticated chat tool-sheet in a TEST-capable build after T7 has
applied the required migration and deployed the matched Backend/Frontend:

1. Start with a user missing the new fields or a newly created user; open
   「生成偏好」 and confirm all three switches are on by default.
2. Toggle each of 「结尾给出选项」「状态栏」「记忆区」 off, then back on one at a
   time; reload the tool sheet after every save and confirm only the selected
   field changes.
3. Exercise all eight three-switch combinations; reload after each combination
   and confirm the server response, not local optimistic state, determines the
   visible values.
4. Throttle or hold the PATCH request; confirm controls cannot submit a
   duplicate save while pending. Force a non-2xx PATCH response; confirm the
   inline failure message appears and controls become usable for retry.
5. Repeat on a narrow mobile viewport and Telegram WebView: all labels remain
   readable, switches remain tappable, and the sheet can scroll to custom
   instructions without clipping.

## Environment boundary and remaining work

No TEST/Production database write, configuration write, migration apply,
deployment, remote publish, commit, or push was performed. T7 still owns the
environment-level migration and matched-app verification, the above manual
matrix, cross-layer prompt/turn behavior, and T1-P's Production tag-protocol
read-only evidence.
