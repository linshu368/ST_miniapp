# TTZF epay cutover design

Approved by the user on 2026-11-09 to begin implementation. Signature casing corrected from the supplied screenshot: MD5 output is lowercase. User explicitly selected epay only; no native API adapter.

## Protocol evidence

User screenshots, supplied 2026-11-09, supersede inaccessible Google-document retrieval. Public gateway: `https://ttzf8.com/api/`.

- Creation: POST `/epay/mapi.php`, UTF-8 form body. Fields: pid (application ID), type, out_trade_no, notify_url, optional return_url, name, money (yuan, up to three decimals), clientip, optional device/param/sitename, sign/sign_type.
- Signature: ASCII ascending names; omit sign, sign_type, signType and empty values; join raw, unencoded `key=value` pairs with `&`; append the application secret directly; lowercase MD5. Form-encode only after signing.
- Creation success: numeric code=1, trade_no, payurl and optional qrcode/urlscheme. Start with verified HTTPS payurl support; QR-only/app-scheme-only replies require explicit supported UI behavior rather than passing them off as hosted checkout.
- Notification: GET with pid, trade_no, out_trade_no, type, name, money (actual paid amount), trade_status, optional param, sign/sign_type. Only TRADE_SUCCESS is paid; TRADE_PENDING/TRADE_REFUND/TRADE_ERROR never grant benefits. Return literal success after durable accepted processing or a safe duplicate.
- Single order query: `/epay/api.php`, act=order, pid, key and trade_no or out_trade_no; numeric code=1 is a successful query; status=1 paid, status=0 unpaid. Verify returned identity, channel and money. A query that returns unpaid is not proof of an irreversible unpaid terminal state.
- The user explicitly reselected the documented GET lookup after the URL-secret restriction was explained (2026-11-09). This task-specific instruction authorizes key in the server-to-provider HTTPS lookup URL only. Do not log URLs or propagate raw transport errors; redact key/sign and callback queries from telemetry including standalone spans. Redirects and caching are disabled. No POST fallback or live success is assumed.

## Reuse investigation

| Searched implementation                                  | Decision                                                                                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VexutopiaPaymentGateway and its consumers                | Replace vendor protocol. Extract only existing multi-consumer internal gateway types as needed; remove Vexutopia HMAC, tx\_ validation, batch and webhook-registration assumptions.                                    |
| RechargeUseCase                                          | Reuse local product/VIP snapshots, event recording and reference persistence. Reassess retired vendor amount limits and unknown creation failures. Pass validated request client IP from the route without logging it. |
| PaymentSettlement                                        | Reuse the single amount/atomic fulfilment entry and late-paid recovery. Normalize valid three-decimal epay money exactly; third-decimal fractions must never be rounded into a match.                                  |
| MiniappPaymentOrderRepository / existing completion RPC  | Reuse ownership, attach/complete/reopen methods and atomic fulfilment. Row has no provider discriminator; no migration currently proposed.                                                                             |
| PaymentReconciliation / worker / expiry scripts          | Reuse orchestration and events. Replace batch lookup with bounded single-order queries, fair selection and partial-failure handling. Remove fake tx\_ idle probe.                                                      |
| Shared payment DTOs                                      | Preserve user-facing contract; add any external callback schema here before route consumption. Keep internal implementation types in backend.                                                                          |
| Frontend payment hooks and checkout/return helpers       | Reuse; do not introduce direct fetch or a second checkout state store.                                                                                                                                                 |
| PaymentAlertRules / callback report / webhook management | Reuse event model and diagnostics, update provider text and obsolete CLI operations.                                                                                                                                   |
| config.ts / runtime-config / Railway / PR workflow       | Reuse startup-env and managed-runtime-config boundaries; update main backend and all payment-service refs together, including per-environment notify URL.                                                              |
| Existing payment tests / UI @recharge                    | Adapt existing tests and fixtures; add focused signature/security regressions under reviewed plan. UI fixtures cannot prove actual money flow.                                                                         |

No active-source epay/TTZF implementation was found. Historical task prose is not the new protocol authority. Existing module prose mentions return as a fourth settlement path, whereas actual return routes perform authoritative query with source=query; retain actual behavior and the historical return union value.

## Minimal sufficient change

Keep UI -> shared DTO -> payment routes -> recharge/gateway -> repository, with every trusted paid fact entering settlePaidOrder. One concrete new gateway, a small protocol helper and a notification handler are sufficient. No provider registry, queue, cache, dynamic router, new wallet state or SDK dependency.

Proposed env names: TTZF_BASE_URL, TTZF_APP_ID, TTZF_APP_KEY, PAYMENT_NOTIFY_URL, existing PAYMENT_RETURN_URL/PAYMENT_ENABLED. Do not put the merchant number into pid. Read secrets only through central startup config; use existing runtime config for product/channel policy.

Split touched over-budget code rather than growing it: old gateway is 538 lines; paymentRoutes is 217 lines; alert evaluator is 188 lines. Tighten the complexity baseline only after eliminating the relevant entries.

## Failure model and reliability

| Failure                                 | Response                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slow upstream/body                      | Explicit overall-call timeout covering body parse; provisional create 7s/query 5s/pass 25s, with no reset on retry.                                                                              |
| Unknown create outcome                  | No blind POST retry without provider idempotency evidence. Preserve query-by-local-order recovery, including missing-reference cases, rather than marking potentially paid orders unrecoverable. |
| Read error/429/5xx                      | No in-call retry; periodic reconciliation provides bounded safe-read retries, with durable queue rotation. No auto-switch to Vexutopia.                                                          |
| Forged/duplicate/conflicting GET fields | Validate scalar fields, body/query bounds, lowercase MD5 with constant-time comparison, application/order/amount/channel/reference. Reject ambiguous duplicates; signatures never logged.        |
| Early callback vs attach                | Permit only authenticated identity-matched association; attached conflicting reference must fail. Atomic settlement remains authority.                                                           |
| Concurrent callback/query/job           | Existing DB lock and fulfillment_applied/legacy credits_added enforce once-only effects; no process mutex for correctness.                                                                       |
| Lost callback / delayed payment         | Query polling and jobs converge through the same settlement; late-paid expired orders retain recovery.                                                                                           |
| Partial DB failure                      | Atomic completion; durable success acknowledgement only after accepted completion. Existing noncritical notification/event failure must not corrupt payment state.                               |
| Query capacity / starvation             | Bounded concurrency and candidates, overall pass deadline, fair cursor/rotation if needed. Slow/poison orders cannot starve later candidates.                                                    |
| status=0 / failed or omitted response   | Keep recoverable, never fabricate finality or paid state. Expiry respects unknown upstream state and late-payment recovery.                                                                      |
| Actual paid amount has third decimal    | Compare exact amounts against integer-cent local price; accept equivalent trailing zero only, reject non-cent fractions.                                                                         |
| Refund                                  | Observe/report according to existing policy, no invented automatic wallet reversal.                                                                                                              |
| Observability                           | Existing Pino and event classifications; allowed IDs/state/duration/counts only; original errors as { err }, redact request URLs/headers/bodies/secret/signatures/client IP.                     |

No transaction protocol, new DB objects or schema migrations are currently needed. If provider isolation requires persisted metadata, revise design under the database spec before writing any migration.

## Old orders, rollout and recovery

Current generated local order IDs are MA*<user UUID>*<timestamp>\_<random>; repository row has no provider identity. Introduce a new local ID namespace: EP followed by 30 lowercase cryptographic hex characters (32 total), instead of depending on the provider trade_no format. Database uniqueness remains the collision guard. This keeps local user identifiers out of provider order numbers and fits Telegram return parameters. Verify all ID consumers before implementation. All new-provider creation/query/notification paths require this namespace; old IDs remain visible and are never queried at TTZF. No schema change or inferred provider-transaction prefix is needed. Send the current environment as signed param and require its documented echo before accepting callbacks/queries, so shared credentials do not erase environment isolation.

Historical completed rows remain unchanged. Old unresolved orders require an audited cutover disposition; source-only research cannot determine their real payment state. Do not mark them paid or silently cancel them. Retain clear operational reporting for manual resolution; do not automatically contact retired Vexutopia.

Sequence: review -> local implementation/checks -> verify authenticated documented GET query and actual response shape in a named TEST/provider scenario -> deploy TEST main/worker/Cron together -> real Android/iOS Alipay/WeChat handoff and exact fulfilment -> reviewed production in-flight drain/config/deployment.

Stop on paid-but-unfulfilled, reference/amount/environment mismatch or unverifiable queries. Disable new checkout while retaining recovery for already-created TTZF orders. Reverting to a Vexutopia-only binary would strand TTZF payments; use a compatible recovery build or forward-fix. Do not automatically re-enable retired Vexutopia.

## Verification scope

Regressions: exact signature vector, Unicode/raw escaping/empty/excluded fields, tampering, duplicate fields, identity/amount/channel/reference mismatch, 3-decimal money, HTTPS checkout, malformed provider data, missing config, timeout through response decode, 429/5xx, unknown creation result, early notification, concurrent/duplicate confirmation, callback loss, write failure/retry, late payment, old-order isolation and bounded/fair reconciliation.

Reuse existing @recharge fixture flows for consumer/return/reopen/failed recovery. Recommend adding successful checkout-return/paid states there if approved; no one-off mock server. Real charges, provider callbacks, Telegram app handoff, DB fulfilment and P95 need separate evidence.
