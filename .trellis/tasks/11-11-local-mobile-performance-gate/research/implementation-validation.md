# Implementation validation — 2026-11-11

## Verified so far

- Python Trellis/gate regressions: 41 passed; unsafe archive fails before module/task mutation.
- Frontend existing suite: 746 passed; after local observer/ready additions, targeted timing suite 58 passed. Platform observation is asserted by the real runner; formal sampling pending.
- Shared: 222 passed. Backend: 1486 passed with 5 timing-related failures while production build was competing for CPU; isolated rerun of all 3 affected files passed 77 tests. TEST-target guard: 9 passed.
- All workspace typechecks passed. Isolated production frontend build passed twice consecutively after disabling standalone for this tool. Next's Windows standalone cleanup had removed linked dependency files; restored via frozen-lockfile pnpm install, isolated repeat builds leave Next/React dependencies intact. Standard tsconfig remains unchanged.
- Chromium 156.0.8078.4 and WebKit 27.2 launch successfully; host is Windows, both platforms are emulated.
- TLS: obtained CA using the public URL from the official Supabase Studio source; no certificate bypass. TEST session pooler target is checked before any access.
- User confirmed both chat migrations applied to TEST; read-only preflight verified required objects and schema/config hash. A large catalog transfer initially timed out; moving the fingerprint aggregation into PostgreSQL made preflight pass.

## Actual run status

First full attempt: output/performance/2026-11-11T07-03-37-311Z. Stopped before formal samples because browser device emulation alone did not populate Telegram platform-specific scheduling. Exact manifest cleanup command completed with exit 0, including remaining-row checks. No performance pass claimed. Browser host now injects platform launch parameters and readiness observation checks actual app platform; formal run will restart as a new batch.

Second attempt: output/performance/2026-11-11T07-17-31-617Z. Stopped during synthetic seed, before formal samples, to finalize lock ownership cleanup and include view definitions in the catalog fingerprint. Exact-manifest cleanup exited 0 with remaining-row checks.

Final mechanism checks: 41 Python tests and all workspace typechecks passed again. Nine TEST-target guard tests and the scenario action-contract test passed. A live TEST advisory-lock conflict rejected cleanup and left its exact manifest untouched. Complexity check passed (existing unrelated baseline warnings remain).

## Remaining

- Complete formal 28-group TEST run (20 per group; latest user instruction), inspect P95 and failure distribution, adjust/retest if needed.
- Verify complete synthetic-history traversal and exact cleanup; retain any interruption as incomplete.
- Finish local UI consumer checks, final static checks and module payload review.
- Publish/enable required Performance Gate only through the approved repository workflow; no commit, push, production deployment or branch-protection write performed.
- Original chat task retains OPTIONS measurements, stricter no-regression/write analysis, real rollout checks and whole-task archive requirements. This mechanism does not auto-complete that task.

## Final functional regression in progress

The full @chat|@roleplay run completed in 13.4 minutes: 61 passed, 1 timed out (exit 1). Its first Android send/regenerate/cancel case hit the unchanged 45-second total test deadline; retained diagnostics under ignored output/performance/ui-regression-first-timeout. The same case passed on narrow in 21.1 seconds. Recheck the Android case separately after the full suite; retain both outcomes. No functional timeout is counted as a performance success.

Fixture review: synthetic character enabled=true and is_test=true so the real character detail permission chain succeeds. No operations listing/layout is changed. It may appear in TEST non-recommended directories during the bounded run and is removed by exact manifest cleanup.

The isolated Android rerun also exceeded the same test-wide 45s budget. Its trace measured `page.goto` at 44,767ms, before the functional assertions; this identifies cold Next dev compilation as the immediate timeout source. Following the documented persistent preview workflow, precompile the existing chat route and rerun with the original unchanged functional deadline. This dev-only preparation is not included in or substituted for production-build performance sampling.

Persistent-preview Android recheck passed unchanged in 15.6s (31.4s total runner). Combined with the 61 passing full-suite cases, all 62 functional cases are covered. The two cold-dev timeout outcomes remain recorded; the full first run itself is not relabeled as green. Preview processes were stopped before real performance sampling.

Full attempt 2026-11-11T07-56-04-036Z: production build passed, fixture INSERT rejected with SQLSTATE 23514 before any sample. Catalog inspection identified characters_test_cards_disabled (is_test implies disabled). Transaction rolled back; exact manifest cleanup independently exited 0. No constraints changed. Fixture v2 uses a private owner-only draft, with privacy attached before commit after historical inserts to avoid immutable creator versions; runtime read compatibility is verified, generation/version binding is outside this dataset. Earlier enabled/is_test fixture intention was rejected and never committed.

## Real TEST batch and bottleneck evidence

Batch 2026-11-11T08-00-53-987Z completed production build and committed private fixture (10 + 10,000 turns, real triggers retained). Chromium 156 / WebKit 27.2 launched. Five consecutive lobby document warmups failed readiness; the safety stop ran, exact cleanup confirmed true, schema fingerprints matched. Formal samples = 0; all 28 groups remain incomplete/blocked, no P95 claimed. Full-history traversal was not reached.

Separate diagnostics after cleanup (not performance acceptance samples):

- Real app public lobby GET returned 200 in 36,708ms on one cold diagnostic.
- Public ordering phase: 8,740 / 9,310ms; head-card phase: 4,520 / 4,024ms.
- Catalog EXPLAIN ANALYZE: public order execution 32.298ms / planning 0.099ms / 815 rows, ranking execution 0.123ms / 268 rows; no physical reads in these observations.
- Prisma SELECT 1: cold 3,484ms; reused connection 242 / 241ms.
- Same public order over Prisma: 7,974 / 6,915ms. Over pg: 4,731 / 5,076ms for approximately 99,306 JSON bytes. These are local transport/client diagnostic observations, not production evidence or 200-sample estimates.
- Public card assets returned TEST Storage origins. No business rows, credentials or raw bodies were exported.

Network baseline requires an explicit reproducible choice before accepting a new batch. User was asked whether to stabilize the local database network path or keep current direct routing and optimize against that path. Existing HTTP proxy environment does not automatically proxy native PostgreSQL TCP. No OS proxy/routing configuration was changed.

Final synthetic-only transport preflight (2026-11-11T08-23-30-880Z): strict TLS/target/catalog checks passed; SELECT 1 roundtrip 246ms; 102,400 generated bytes transferred in 7,383ms. This confirms the transport symptom without reading business records. Backend typecheck passed after adding the diagnostic. Own local TEST/preview services are stopped; no listeners remain on 3130/3131/3140/3141. No commit/push/deployment/archive performed.

User steering after diagnostics: keep the existing direct network and optimize the application. Final sampling instruction supersedes 200 and the intermediate 100: each platform/page/API/scenario now uses 20 samples, P95<=2000ms (nearest-rank 19th of 20). Policy local-mobile-p95-v2 and current plans/docs updated; 41 Python tests passed. Historical failed batches remain unchanged.

Direct-network optimization diagnostics (not acceptance P95): conditional catalog validation reduced refreshed public-order reads to 963/516ms; unchanged head projection reduced repeated real app public GETs to 1380/726/715ms (first cold GET 16796ms retained). Description/tags/order/visibility/uncapped-featured behavior validated by actual local PG17 SQL, plus dedicated contract/concurrency/capacity tests. Standalone local cluster stopped after test DB cleanup. Full backend regressions and fresh 20-sample batch follow.

Final pre-run checks after conditional catalog/head reads: full Backend suite passed 138 files / 1513 tests; all workspace typechecks passed; complexity gate passed with existing unrelated baseline warnings. New 20-sample run started at 2026-11-11T08-53-44-755Z using unchanged direct network. No acceptance result claimed before completion.

## User-requested suspension — 2026-11-11

User explicitly withdrew this mechanism and its mandatory future-development gates. Last batch 2026-11-11T08-53-44-755Z stopped after five lobby business_ready warmup failures; zero formal samples, cleanup_complete=true, schema fingerprints matched. No acceptance claimed. Both owned local services exited. Removed runnable harness, root/package commands, CI workflow, runtime marks, specialized build configuration, start/archive/stale checks and mandatory task defaults. Historical evidence remains; implementation-only snapshot is ignored at output/performance/deferred-20261111/implementation.zip. Task status is paused, not completed or archived. No production migration or deployment was performed.

## User clarification — existing gates preserved

The user clarified that only mandatory future local performance testing is withdrawn. Restored the pre-existing task-create mobile_performance defaults/PRD checklist and task-start declaration validator, with their original regressions. Existing planning/quality/module/acceptance gates remain applicable. Only the paused 11-11 sampler and its newly proposed result/archive/CI enforcement remain disabled. Earlier broad-removal wording describes the intermediate action and is superseded by this correction.
