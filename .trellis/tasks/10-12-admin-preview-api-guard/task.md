# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                                                               | Files / Scope                                                                    | Depends On | Verification                                                                                                                                       |
| --- | ------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Done   | Map and unit-test deterministic Admin Preview API resolution                                       | `packages/admin/src/lib/preview-api.ts`, `environment.test.ts`, `vite.config.ts` | -          | Targeted Admin tests passed; normal build refreshed `dist`                                                                                         |
| T2  | Done   | Add deployed Preview-to-Railway health/CORS smoke gate using only public, credential-free requests | `.github/workflows/railway-pr-env.yml`                                           | T1         | Static workflow review pending final formatter check                                                                                               |
| T3  | Done   | Surface a specific unavailable-backend state before login submits credentials                      | `packages/admin/src/App.tsx`, `environment.ts`                                   | T1         | Admin typecheck and build passed                                                                                                                   |
| T4  | Done   | Run validation and record deployment/rollback procedure                                            | Admin docs and task log                                                          | T1-T3      | 93 Admin tests passed; typecheck/build passed; valid PR build passed; invalid branch Preview build failed as designed; YAML and diff checks passed |

## Execution Log

- Planning: existing resolver and Railway PR lifecycle found; no reusable deployed Preview smoke gate exists. The PR environment workflow is the likely extension point because it creates the deterministic backend origin.
- Implementation: extracted a dependency-free resolver for Vite config and tests; login now checks `/health` before a session/client request; PR environment workflow waits for health then validates Admin proxy CORS without credentials.
- Validation: `pnpm --filter @miniapp/admin test` (93 passed); `VERCEL_ENV=preview VERCEL_GIT_PULL_REQUEST_ID=364 pnpm --filter @miniapp/admin build` passed; a Preview build with empty TEST API and no PR id failed with the expected `VITE_ADMIN_TEST_API_URL` message; Prettier, Ruby YAML parse, and `git diff --check` passed.
- Rollback: revert the Admin resolver/build guard, login health check, and workflow verification together. No database or environment variable writes were made.
