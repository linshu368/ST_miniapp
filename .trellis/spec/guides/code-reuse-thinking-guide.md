# Code Reuse Thinking Guide

Before creating helpers, constants, API clients, parsing logic, or config readers:

1. Search first with `rg`.
2. Identify the current owner of the pattern.
3. Extend the owner instead of adding a parallel implementation.
4. Add tests at the owner boundary when behavior changes.

Common ST_miniapp owners:

- API contracts: `packages/shared/src/api/*`
- Frontend REST client: `packages/frontend/src/lib/api/client.ts`
- Backend runtime config: `packages/backend/src/platform/runtime-config.ts`
- LLM generation and billing: `packages/backend/src/features/generation/`
- Conversation orchestration: `packages/backend/src/features/conversations/`
- Prompt assembly: `packages/backend/src/features/engine/`
- Server logging conventions: `packages/shared/src/logging/conventions.ts` and `packages/backend/src/lib/logger.ts`
- SQL migrations: `packages/shared/migrations/`
