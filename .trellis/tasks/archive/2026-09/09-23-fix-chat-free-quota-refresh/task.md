# Task Breakdown

- [x] T1 Locate chat free-quota source of truth and current refresh path.
- [x] T2 Identify why current-session quota remains stale after SSE completion.
- [x] T3 Implement the smallest cache/state refresh fix.
- [x] T4 Run targeted frontend/shared/backend validation where applicable.
- [x] T5 Document outcome and any unrelated blockers.

## Notes

- Root cause: after SSE success, the chat hook fired free-quota refresh in the background and immediately released the composer; a fast next send could still read `freeQuotaRef.current` from the previous render/cache value.
- Fix: when a free-quota refresh returns data, synchronously update both React Query cache and the hook's local quota ref, and keep the composer in `generating` state until the needed refresh completes.
- Scope guard: paid selected models skip the free-quota refresh wait, while unknown/catalog-loading state remains conservative.
- Validation:
  - `pnpm --filter @miniapp/frontend test -- src/hooks/use-conversation-turn.test.ts`
  - `pnpm --filter @miniapp/frontend typecheck`
  - `pnpm --filter @miniapp/frontend lint`
