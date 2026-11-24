# Relay provider integration contract

## Scope / Trigger

Packy / OneXModel text generation, authorized model directories, native cost observations and account balance probes. Local implementation is separate from remote migration/deployment/paid acceptance. See [runbook](../../../../docs/relay-providers.md).

## Signatures

Extend `LLM_PROVIDER_CAPABILITIES` and the existing provider directory/transport. Admin balance is `GET /api/admin/model-providers/:provider/balance`. CLI is `model-provider models|balance`. Managed key is `llm_relay_provider_config`; calls/jobs remain in ops, not provider tables.

## Contracts

Inference Key and management system token/user ID are separate. Runtime config owns `1XM_*`, `PACKY_*` and the deployed `USERT_ID` spelling. Optional local provider proxies follow Venice's opt-in pattern. Never follow credential-bearing redirects. Directory authorization comes from the configured Key; public pricing only supplies capability evidence. Unknown USD stays NULL; quota ratios/display currency do not prove real dollar cost. Cache/reasoning token counters are subsets. Original provider routing/caching fields stay provider-gated.

## Validation & Error Matrix

Missing credentials, HTML, auth/429/5xx and timeout preserve explicit unavailable/stale states. Real zero is distinct from missing/failed. Cost jobs use database leases, finite retries/windows and exact request/account/Key/model attribution; refunds, duplicate/contradictory invoices and incomplete pagination are never guessed. Failed or skipped balance samples reset consecutive recovery; no healthy evaluation after probe failure. Ledger/monitor/notification failures cannot change user billing.

## Good / Base / Bad Cases

Good: authenticated Key returns an empty model list and Admin shows the empty state. Base: management credentials are absent but inference remains usable. Bad: importing all public pricing models to hide an empty Key list, treating quota as USD, silently changing model/Key/group, or retrying a model POST to collect usage.

## Tests Required

Extend existing contracts/transport/directory/recovery/CLI coverage and run `relay-providers.test.ts`. Verify actual sanitized log fields, schema/runtime consumers, legitimate zero, missing usage, exact/ambiguous/refund invoice paths, leases and invoice uniqueness. `test-relay-provider-migration.mjs` is PG17 WASM supplementary evidence: verify CONCURRENTLY, multiple connections, capacity and final source hashes on independent PG17/TEST before production. User may waive local UI tests without waiving typecheck/build or remote release checks. Isolate local optional credentials in Node child-process env; empty PowerShell env assignment deletes a variable and dotenv can load it again.

## Wrong vs Correct

Wrong: infer success from mocks, source migrations or a public model list. Correct: label repository/local/TEST/production evidence separately; keep unknown values unknown, fail on unrecognized function source hashes, and publish new models only after migration and consumer verification. Roll back by disabling new providers while retaining historical observations and compatible enums.
