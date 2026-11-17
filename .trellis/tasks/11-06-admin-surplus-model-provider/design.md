# Technical design

## Boundaries and data flow

1. Shared adds `surplus` to the provider schema, labels and capability registry.
2. Admin derives provider panels/options from that registry and loads all provider directories on mount.
3. Backend runtime configuration resolves Surplus only from `SURPLUS_API_BASE_URL` and `SURPLUS_API_KEY`.
4. The provider directory adapter calls the public `<base>/models`, parses the bounded Surplus Intelligence data array and returns the existing shared directory DTO.
5. Generation uses the existing OpenAI-compatible transport to call `<base>/chat/completions` with Bearer authentication. OpenRouter routing/headers and Venice parameters/cache keys remain provider-gated.
6. Fixed-tier billing uses the existing frozen snapshot. Recovery scans Surplus snapshots directly because no asynchronous provider metadata is required.

## Contract and compatibility

- `provider: surplus` is additive; old configs without provider still normalize to OpenRouter.
- `openrouter_model_id` remains the legacy mirror field for catalog compatibility, while routing uses `provider + provider_model_id`.
- No public HTTP shape changes beyond accepting/returning the new enum value.
- Existing OpenRouter fallback stays OpenRouter-only; Surplus is not silently inserted into first-token fallback races.

## Reliability design

- Timeout: directory refresh uses the existing 8-second abort budget; generation keeps the global generation deadline.
- Retry: no automatic network retry is added. Directory concurrent refreshes coalesce; a previous cache is returned as stale on failure.
- Idempotency/concurrency: catalog publication keeps existing draft/version semantics; billing uses existing charge IDs and idempotent charge RPC.
- Transaction/compensation: no new multi-write transaction. Failed billing remains unsettled and is repaired from the frozen snapshot.
- Degradation: directory failure does not erase cached results; missing runtime key fails before dispatch with a bounded logged error.
- Rate/capacity: directory cache avoids per-Admin-view upstream calls; no new polling or cron.
- Observability: provider/model labels and provider alert fingerprints retain `surplus`; logs contain status, duration context and IDs but no key or response body.

## Minimal sufficient shape

- No new database object, state source, public endpoint, package dependency or CLI command.
- Add one provider adapter and focused contract/runtime tests; extend existing UI and transport tests.
- A generalized plugin system is rejected because the supported provider set is compile-time controlled and only three entries.

## Evolution, rollout and recovery

- Deploy backend/shared/admin before publishing any catalog entry with `provider=surplus`.
- Configure both Surplus environment variables in each target backend environment before use.
- Validate directory sync first, then a non-production model generation and billing record, then publish catalog changes through the existing draft/diff/publish flow.
- Stop condition: missing/invalid directory data, elevated provider errors, missing billing settlement, or mislabeled metrics.
- Rollback: remove/disable Surplus catalog entries and redeploy the prior application version; no data migration rollback is needed. Existing Surplus-tagged snapshots remain readable by the additive shared enum in the deployed version, so prefer forward-fix after first production use.

## Verification strategy

- Parser: valid response, malformed envelope, invalid/missing pricing, empty valid model set, cache/stale behavior and absence of an Authorization header on the public model-directory request.
- Runtime/transport: env URL/key selection, correct endpoint, absence of OpenRouter-only headers and Venice-only body behavior.
- Admin: provider panel/selection and initial load of all registered providers.
- Recovery: Surplus pending billing row mapping and sync inclusion without provider detail tables.
- Consumers: shared, backend, admin, admin-client/CLI typechecks; relevant existing tests; lint/build/complexity checks.
- Manual: run Admin against a configured non-production backend, refresh Surplus, add a model to a draft and inspect diff without publishing production configuration.

## Surplus balance monitor extension

- Probe authenticated `GET ${SURPLUS_API_BASE_URL}/payments/balance` with `SURPLUS_API_KEY`, a 5-second timeout and at most two attempts. Retry only timeout/network/5xx failures with bounded backoff; do not retry authentication, other 4xx or invalid payloads.
- Parse only `credit_balance_usdc` as a non-negative integer-microdollar string and convert it to USD once for the existing policy. Ignore the deprecated on-chain `balance_usdc` / `allowance_usdc` fields. Never log the key, monetary string, account metadata, raw response body or URL query data.
- Reuse the Venice policy: P1 below $10, stable provider-specific fingerprint, firing evaluation every low pass for outbox dedupe, and recovery only after two consecutive healthy passes.
- A skipped or failed probe never emits healthy and cannot close an active incident. Surplus failure marks the shared monitor round partial but does not block payment rules, Venice monitoring or outbox delivery. The two provider probes run with bounded concurrency of two so their timeout budgets do not add serially to the minute-level worker cadence.
- Run inside the existing `stminiapp-payment-alert-monitor` loop and advisory lock. No new service, database object, state source or dependency is added.
- Railway IaC references Surplus and Venice provider variables from the API service only for the alert-monitor worker. Deployment remains an explicit `railway config plan/apply` operation and is not performed by this task.
- Rollback removes the Surplus monitor call and its worker environment references; existing outbox incidents are then left for operational closure or a forward fix. No data rollback is required.
