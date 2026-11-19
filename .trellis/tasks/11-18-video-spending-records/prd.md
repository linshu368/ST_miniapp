# Video spending, configured quotes and default covers

User confirmed balance deduction works and the defect is missing spending display, after the preceding production/code diagnosis. This is the authorized scope correction: fix the read/display path, never deduct again. Earlier payment-query optimization remains separate and is not mixed into this fix.

## Requirements/acceptance

- Include existing media_plaza_video_reserve debit and media_plaza_video_refund credit ledger records in GET /api/wallet/spending, scoped to the authenticated user and sorted with current spending.
- Show video debit and refund as distinct records even for the same attempt. Use original ledger times and amounts. Refund is a positive UI credit, not another debit; expose actual main/bonus deltas using existing DTO fields.
- Preserve existing text/voice/image/refund records, their query limits, error behavior and idempotent charging/refund logic. Historical video ledgers become visible after release without backfill or wallet writes.
- Extend existing repository regressions for ownership, zero/one/many rows, debit/refund same attempt, numeric strings, sorting and failure; extend existing @profile fixture acceptance for debit/refund signs and split.
- No database change, new dependency, paid generation, account adjustment or automatic deployment/commit/push. The cover scope below adds only an optional conversation response field from an existing column. Real production amounts are not read via Supabase MCP.

## Confirmed R2V quote scope addition

User additionally reported MiniMax H3 Max R2V missing price and confirmed no reference image was added. Current mode selection incorrectly requests t2v before a reference exists; production quote requests show400. Quote required-reference models as r2v immediately, since price needs only model/duration/resolution/audio, while generation still requires an uploaded reference. Do not change prices or bypass submit reference authorization.

User explicitly waived local UI tests during execution. Stop the launched UI run and do not restart it; retain prepared fixture/tests for future repeatable acceptance, mark them unverified. Continue unit/type/build/static checks.

## Confirmed cover fallback and configured pricing

User requires models needing reference images to use the current work cover when no manual reference exists; quote must follow configured prices. Scope is video required-reference modes and historical non-t2v retries. Manual references always win. Source cover is the selected retry artifact, otherwise the conversation source work, otherwise latest ready output in that conversation. A genuinely empty conversation has no cover: require an upload rather than invent an image. No UI tests per user.
