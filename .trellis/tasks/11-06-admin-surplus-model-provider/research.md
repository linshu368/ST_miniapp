# Reuse and evidence research

## External contract

- Surplus Intelligence official docs (`https://www.surplusintelligence.ai/docs`) define the canonical OpenAI-compatible base as `https://api.surplusintelligence.ai/v1`, with `GET /models` and `POST /chat/completions`.
- The live public model list uses `{ data: [...] }`; a read-only shape check confirmed `id`, `name`, `description`, `context_length`, and `pricing.prompt` / `pricing.completion` fields without relying on credentials.
- The repository-provided environment names are authoritative for this integration: `SURPLUS_API_BASE_URL` and `SURPLUS_API_KEY`.

## Repository searches

- Shared contracts/capabilities: `packages/shared/src/api/models.ts`.
- Admin provider directory UI/state: `packages/admin/src/components/ModelCatalogEditor.tsx`, `packages/admin/src/App.tsx`, `packages/admin/src/lib/openRouterModels.ts`.
- Managed config and CLI reuse: `packages/admin-client/src/configSchemas.ts`, `packages/admin-client/src/menu.ts`; the existing generic `config` CLI already covers `llm_model_catalog`, so no new command/API is needed.
- Backend directory/cache: `packages/backend/src/platform/model-provider-directory.ts`.
- Backend credentials: `packages/backend/src/platform/runtime-config.ts`.
- Generation transport: `packages/backend/src/features/generation/upstream.ts`, `execute.ts`, `prompt-caching.ts`.
- Billing/recovery: `packages/backend/src/features/generation/settle.ts`, `sync-job.ts`, `ConversationHistoryRepository.ts`.
- Observability/alerts: `packages/backend/src/lib/engineering-observability.ts`, `packages/backend/src/features/generation/provider-alerts.ts`.

## Reuse decisions

- Extend the existing `LlmModelProviderSchema`, capability registry and provider-directory registry; do not create a parallel Surplus catalog.
- Extract/reuse a generic cached OpenAI-compatible directory client for Venice and Surplus where doing so keeps the parser explicit and bounded.
- Reuse native `fetch` for Surplus and the existing Bearer forwarding path; do not add an SDK or proxy layer.
- Reuse the existing managed-config Admin editor and CLI. Only the provider registry and initial directory load need extension.
- Reuse the main `chat_history.llm_billing_snapshot` for Surplus recovery. No new provider metadata table is justified because Surplus does not have repository-used asynchronous generation metadata.

## Rejected designs

- No browser-side Surplus request: it would expose `SURPLUS_API_KEY`.
- No new Surplus SDK/dependency: the required endpoints are already OpenAI-compatible.
- No generic provider framework or database migration: two bounded endpoint adapters plus the existing registry are sufficient.
- No reuse of OpenRouter/Venice detail tables: their semantics and constraints are provider-specific.

## Surplus balance monitoring extension

- Surplus Intelligence documents authenticated `GET /payments/balance` relative to the canonical `/v1` base. The spendable balance is `credit_balance_usdc`, an integer-microdollar string; legacy `balance_usdc` / `allowance_usdc` fields must not drive the alert.
- The repository already runs `VeniceBalanceMonitor` inside `src/scripts/payment-alert-monitor.ts`, under the same advisory lock and shared alert outbox. Railway declares that process as the always-on `stminiapp-payment-alert-monitor` service.
- Reuse decision: add a provider-specific Surplus parser/probe/evaluation monitor, but reuse the existing publisher, one-minute process loop, two-pass recovery debounce, $10 USD threshold, failure isolation and delivery worker. This avoids a second scheduler and keeps provider response parsing explicit.
- Deployment finding: the alert-monitor service currently receives the generic payment environment only. Add a monitor-specific environment map referencing both Venice and Surplus base/key variables from `stminiapp`; do not copy secret values into IaC.
- A read-only local probe of `${SURPLUS_API_BASE_URL}/payments/balance` returned HTTP 200 with the documented field names and JSON types. A second probe explicitly retained TLS certificate verification because the local environment contains an unrelated insecure TLS override. Neither probe logged credentials, monetary values or the response body.
