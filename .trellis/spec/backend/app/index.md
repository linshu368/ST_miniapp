# Backend Guidelines

Applies to `packages/backend`.

## Pre-Development Checklist

- Read `packages/backend/CLAUDE.md`.
- Read `docs/ARCHITECTURE.md` sections 1, 4, 6, 7, and 11.
- Read `docs/log_system.md` when touching logging, errors, request flow, or external integrations.
- Search existing routes, features, repositories, and tests before adding new code.
- If external response shapes change, update `packages/shared/src/api/*` first.

## Required Rules

- Fastify 5, TypeScript strict mode, no new `any`.
- Every route registration must have a nearby `@frontend-ready: true|false` comment.
- Shared request/response types belong in `packages/shared`.
- User auth uses `requireTelegramAuth` / `X-Init-Data`; CS/admin/bot endpoints use their existing auth mechanisms.
- LLM generation and billing must go through `src/features/generation/`.
- Runtime config must go through `src/platform/runtime-config.ts`.
- Preserve original errors in logs: `log.sys.error({ err }, 'message')`.
- Use `requestLogger(request.log, module)` in routes that need business/system events.

## Quality Check

- Run `pnpm --filter @miniapp/backend typecheck`.
- Run `pnpm --filter @miniapp/backend test` for backend logic.
- For conversation/generation changes, consider `pnpm --filter @miniapp/backend mvp:regression -- --seed-free-model`.
- Verify changed routes still match shared contracts.
