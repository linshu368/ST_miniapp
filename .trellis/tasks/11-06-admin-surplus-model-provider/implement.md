# Implementation plan

1. Extend shared provider enum, labels and capabilities; add shared regression coverage for `surplus` catalog normalization and duplicate scoping.
2. Add backend Surplus runtime configuration and an OpenAI-compatible directory adapter with timeout/cache/stale fallback; add focused tests.
3. Route Surplus generation through the existing transport, keep provider-specific request behavior isolated, and extend transport/observability/alert tests.
4. Add Surplus frozen-snapshot billing recovery without a database migration and extend recovery tests.
5. Make Admin initial directory loading registry-driven and extend ModelCatalogEditor tests; confirm generic admin-client/CLI config coverage needs no new command.
6. Update environment/deployment documentation and module knowledge payload.
7. Run formatting, focused tests, affected package typechecks/lint/build, shared consumer checks and complexity validation. Record failures and remaining manual provider integration risk.
8. Add a Surplus USD balance probe and P1 monitor by reusing the existing Venice threshold/recovery policy; register it in the shared payment alert monitor loop and pass provider environment references to that Railway worker.
9. Verify parsing, threshold boundaries, retry/failure isolation, recovery debounce, Cron integration and IaC environment wiring; document the non-production live-probe requirement.

## Review and rollback gates

- Do not publish an operations config or execute any production write.
- Do not stage/commit until the final diff and validations have been shown for human approval.
- If the real Surplus `/models` shape contradicts the documented contract, stop and adjust the parser/test fixture rather than accepting unbounded data.
- Rollback is application/config-only; no migration is introduced.
