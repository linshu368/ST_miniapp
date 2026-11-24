# Implementation verification — 2026-11-24

Local implementation is complete. Task remains `in_progress` because remote schema collection, migrations, paid end-to-end acceptance and release P95 have not been completed. No staging, commit, push, deployment, remote migration or production configuration publication was performed. No local UI test or browser session was run, per user instruction.

## Upstream evidence and repairs

- Packy: configured inference and management origins return HTTP 200 with an empty authorized `/v1/models` array. The Key is valid. Read-only token/account metadata identifies its single group as `gemini-slb`; that group has no public pricing models and is absent from the account's selectable groups. This is an upstream resource/group issue. Do not import the public catalog as authorized models. Account group or replacement Key must be decided by its owner; no account changes were made.
- Packy consumption logs: use canonical `/api/log/self`; the trailing-slash form redirects and is rejected by the credential-safe transport.
- OneXModel: original inference host fails DNS. Official `https://api.1xm.ai/v1` and `https://1xm.ai` resolve, but local direct access times out. Existing local Venice proxy reaches both. Corrected only the ignored local inference URL and added `1XM_HTTPS_PROXY` by reusing that local proxy value. No Key, management credential or user ID was changed or copied into tracked files.
- Actual registered application adapters were invoked with read-only GETs: Packy 0 models; OneXModel 9 models, `stale=false`, all 9 prices explicitly unknown. Both management account probes succeeded during protocol investigation. Application balance routes still require runtime-config/DB availability and proper Admin authentication.
- No paid Packy/OneXModel generation was performed. Actual response-ID to invoice-ID attribution, refund semantics and billed usage remain controlled-release acceptance items.

## Changes verified

Existing provider registry/directory, generation dispatch, delivery arbitration, `ops.llm_calls`, cost worker, model catalog publication, Admin authentication, CLI coverage and Publisher/outbox were extended. OpenRouter routing and Venice parameters remain provider-gated. Relay inference does not depend on management credentials. Unknown quota/USD stays separate from zero; cost reconciliation requires exact account/Key/request/model/group attribution and refuses ambiguity or refunds. Jobs use finite retry windows, database ownership leases and one active lookup per provider; 429 is not retried immediately and bounded Retry-After influences the next scheduled attempt.

Admin/client components were split while preserving existing imports and publication behavior to meet the 500-line file / 120-line function budget. Affected baseline entries were removed after splitting. No frontend product file changed; its shared-contract consumers were checked.

## Executed validation

| Check                                                                  | Result                                                                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace `pnpm -r typecheck`                                          | All packages pass                                                                                                                                    |
| Backend suite, optional real credentials isolated in child-process env | 192 files / 2,092 tests pass                                                                                                                         |
| Final focused relay/execute/first-token/directory regression           | 5 files / 155 tests pass                                                                                                                             |
| Shared suite                                                           | 28 files / 381 tests pass, rerun with one worker after load-sensitive timing test failed under parallel CPU load                                     |
| Frontend suite and lint                                                | 82 files / 979 tests pass; existing lint warnings retained                                                                                           |
| Admin suite after component extraction                                 | 11 files / 119 tests pass                                                                                                                            |
| Admin-client suite                                                     | 3 files / 32 tests pass                                                                                                                              |
| CLI suite                                                              | 23 pass; 1 existing POSIX file-mode assertion fails on Windows (`safety.test.ts:225`, mode 0666 versus 0700)                                         |
| CLI command coverage                                                   | 2 tests pass                                                                                                                                         |
| Workspace build                                                        | Pass, including Next frontend and Vite Admin; Admin rebuilt after component changes, existing chunk-size warning retained                            |
| Import boundary lint                                                   | Pass via Node argument-array invocation; PowerShell wrapper's `--rule '{}'` quoting fails before lint execution                                      |
| Complexity                                                             | Pass; affected baseline entries tightened, no allow-new                                                                                              |
| Backend logging lint and alert-rule validator                          | Pass                                                                                                                                                 |
| Migration lint                                                         | Pass                                                                                                                                                 |
| DB contract lint                                                       | Pass with 6 existing warnings in `20261118_media_plaza_video_production_base.sql`                                                                    |
| PG17.5 WASM migration harness                                          | Expansion/replay, policy failure paths, provider checks, invoice uniqueness, NULL/zero, amount/rate bounds, snapshot limit and anonymous denial pass |

Backend isolation must use a Node child process with explicit empty strings in `env` for optional provider credentials. Setting `$env:KEY=''` in Windows PowerShell removes the variable, permitting dotenv to reload it. An initial run of pre-existing DeepSeek status-bar tests contacted the real upstream because their transport mocks did not cover the current direct adapter. This was reported to the user; subsequent complete and focused suites used credential isolation. It is not paid-provider acceptance evidence.

Reproduce the migration harness with an externally installed `@electric-sql/pglite@0.3.14` module:

```sh
node scripts/test-relay-provider-migration.mjs <absolute-path-to-pglite-dist-index.js>
```

PGlite uses PostgreSQL 17.5 and a non-superuser object owner. The harness removes `CONCURRENTLY` only in its execution copy because the WASM engine cannot validate real concurrent-index operation. Independent PostgreSQL multi-session locking, leases under replica contention, capacity and concurrent-index creation are still pending. Repository-derived function bodies/hashes are fixtures, not a claim about a remote database.

## Migration and remaining release gates

Apply `20261124_relay_provider_cost_view.sql` before `20261124_relay_provider_expand.sql`, one file at a time after environment inspection. The expand file was executed locally and its original view-source guard failed on PG17 deparser cast spelling; it remains immutable. The preceding cost-view forward fix handles both cast forms, preserves view columns/ACL and permits repeatable expand execution. Never rewrite an already executed migration.

Confirmed TEST read-only schema collection could not connect: direct host DNS failed and pooler certificate-chain validation failed. TLS checks were retained. Supabase MCP did not provide a usable link identifier. No remote query succeeded and no remote write occurred. Production was not inspected. Before rollout, collect actual CHECK/RPC/source hashes/index/ACL/RLS, verify on independent PostgreSQL then TEST, and stop if any function-source guard differs.

Pending release acceptance: Packy resource/group correction; real OneX/Packy generation and regeneration through published models; all terminal call facts and exact invoice correlation; once-only user settlement and daily billing comparison; real Admin/CLI draft/diff/publish/rollback and account balance monitoring; multi-replica lease behavior; deployment and Android/iOS/API P95. Mobile baseline fields remain null because there are no visible samples. Observe each cohort for 24 hours before and after release; do not report zero or claim a measured pass.

Local UI testing is explicitly waived. Suggested later coverage uses existing `@chat` / `@roleplay` model selection, delisting, regeneration and failure-recovery fixtures; these cannot replace real upstream billing or mobile samples. Runbook and recovery plan: `docs/relay-providers.md`. Keep the task active until release acceptance is separately completed.
