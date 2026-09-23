# PRD: Chat free quota live refresh

## Problem

In the current chat session, after a free text-chat quota is consumed, the visible remaining/free-turn count does not update immediately for the next interaction. Users can continue chatting while seeing stale quota information.

## Scope

- Diagnose the chat session page, conversation API hooks, SSE completion handling, and backend conversation response shape as needed.
- Fix the realtime update path for text-chat free quota after a successful assistant turn.
- Keep the change narrow; do not redesign paywall, wallet, voice, or image flows unless the same cache invalidation helper is directly reused.

## Acceptance Criteria

- After a free quota turn completes, the current chat UI reflects the latest free quota state before the next send/paywall decision.
- React Query cache ownership is respected; no duplicate direct fetch is added in components.
- SSE success/error behavior remains unchanged except for the necessary cache/state refresh.
- Existing related typecheck/tests pass, or unrelated blockers are documented.
