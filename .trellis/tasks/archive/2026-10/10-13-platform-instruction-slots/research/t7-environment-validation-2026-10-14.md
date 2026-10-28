# T7 environment validation evidence — 2026-10-14

## Scope

- Admin URL: `https://st-admin-platform-git-dev-3213527545-4308s-projects.vercel.app/`
- TEST environment reads only; no draft save, publish, rollback, or rule mutation was executed.
- Production environment reads only; no Production write was attempted.

## TEST observations

- Admin loaded successfully with the TEST environment selected and an authenticated owner session.
- Platform rules loaded four tabs: choice, status, memory, and system instructions.
- Current published versions observed: choice v4, status v4, memory v6.
- The runtime field names remain `on_first_two_turns` / `on_later_turns`, but the deployed Admin visible labels still say "开启后前两轮" and "从第 3 个逻辑轮起". The local Admin implementation has been corrected to the current dynamic semantics (turns 1–3 full; turn 4+ concise only after an exact previous revision); deployment remains pending.
- Rich-text rules initially showed a recoverable read failure (`请求恢复`, 0 rules, unpublished). Invoking the read retry restored formal version v8 with four enabled rules: choice, status, memory, and dialogue. The local preview rendered four matches.
- Write-path acceptance (save draft, publish, rollback) was not executed and was explicitly skipped by the user on 2026-10-14. The MiniApp conversation matrix remains separate.

## Production stop condition

- Switching the Admin selector to Production completed the environment confirmation, then the page showed `当前运营环境暂不可用` and `生产环境后端无法连接`.
- Browser console exposed no additional error details.
- Because Production configuration could not be read, the Production tag protocol and source configuration cannot yet be compared with TEST, and no configuration sync is safe.

## Remaining acceptance

1. Resolve or explicitly waive the Production Admin-to-Backend connectivity blocker.
2. Read and compare the Production platform-rule and rich-text formal versions before any sync.
3. Deploy the corrected Admin slot labels before relying on the UI wording.
4. No additional TEST conversation matrix is required in this run: the user confirmed on 2026-10-14 that the device-level matrix, including cross-turn and regeneration cases, had already passed.

## Explicitly skipped

- TEST Admin save-draft, publish, rollback, and refreshed-readback write acceptance. The existing TEST formal versions were only read and previewed.
- TEST MiniApp cross-turn, diagnosis, toggle, regeneration, concurrency, and renderer interaction matrix. The user confirmed this had already passed on a real device; this run did not repeat it.

## Local validation after label correction

- `pnpm --filter @miniapp/admin typecheck` — passed.
- `pnpm --filter @miniapp/admin test` — 12 files / 97 tests passed.
- `pnpm --filter @miniapp/admin build` — passed; only the existing chunk-size warning remained.
- `pnpm -r typecheck` — passed for all participating workspaces.
