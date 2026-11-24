# Executable work and remaining acceptance

Implementation was authorized on 2026-11-24. Reuse existing Venice/OpenRouter adapter entry points. User waived local UI testing. Local OneX endpoint/proxy repair was authorized by the subsequent diagnostic request. No remote migration, publication or deployment was performed.

- [x] T1: Read-only upstream protocol investigation. Authorization, zero/unknown units and safe account/Key scoping implemented. Packy's empty authorized group remains an external blocker.
- [ ] T2: Collect actual TEST and production schema/source hashes/ACL/indexes. TEST connection failed DNS/certificate validation; no bypass or remote query.
- [x] T3: Shared registry, unknown prices, balance/policy contracts, runtime config and consumer typechecks.
- [x] T4a: Minimal calls/jobs/config migrations and registry; PG17.5 WASM non-superuser/replay/validation/uniqueness checks.
- [ ] T4b: Independent PG17 multi-session/concurrent-index/capacity checks and TEST migration. WASM does not prove these.
- [x] T5: Provider-scoped management transport and authorized directories; bounded GET/retries, stale cache, chat modality and unknown pricing.
- [x] T6a: Existing model editor, policy/balance controls, shared admin-client requests, CLI commands and coverage.
- [ ] T6b: Real environment-bound draft/CAS/publication/rollback acceptance after migration; production writes require a reviewed diff and explicit user approval.
- [x] T7a: Existing generation transport/SSE parameters and fixed-price recovery extended; frontend shared consumers validated without a second routing path.
- [ ] T7b: Published real model send/regenerate/once-only settlement acceptance.
- [x] T8: Dispatch-time call identity, bounded terminal usage observations and native cost fields; no content snapshot or loser draining.
- [x] T9a: Exact invoice matching, finite retries, provider concurrency, ownership leases and unavailable/conflict handling; no fabricated cost.
- [ ] T9b: Real invoice/refund/late-record attribution and multi-replica ownership acceptance.
- [x] T10: Balance API and monitor/Publisher integration; disabled defaults, dedupe, two consecutive healthy recoveries, IaC prepared without deployment.
- [x] T11: Existing suites/typechecks/build, approved regression, logging/migration/DB/import/complexity checks. CLI's existing Windows POSIX-mode failure is recorded in verification.md.
- [ ] T12: TEST then controlled production migration and real billing reconciliation after separate authorization.
- [ ] T13: Android/iOS/API real P95 window after release. Local UI/fixture work is waived; later reusable scenarios are documented.
- [x] T14: README, architecture, runbook, backend spec, CLI documentation and module-update payload prepared. Task not archived; no commit/push.

Evidence, pass counts, local credential test incident, migration order and release limits are in `verification.md`.
