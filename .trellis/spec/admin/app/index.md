# Admin Guidelines

Applies to `packages/admin`.

## Pre-Development Checklist

- Read `docs/ARCHITECTURE.md` sections 3, 6, and 7.
- Inspect existing admin components and `src/lib/*` API helpers.
- Check whether the feature should go through backend admin proxy or Supabase session.

## Required Rules

- Vite + React + AntD + Refine patterns.
- Use existing `src/lib` helpers for API and Supabase interactions.
- Consume `packages/shared/src/api/*` for shared contracts where available.
- Do not import from `frontend`, `backend`, or `cs-platform`.
- Do not alter operational UX without PRD approval.

## Quality Check

- Run `pnpm --filter @miniapp/admin typecheck`.
- Run `pnpm --filter @miniapp/admin test` for logic changes.
- Run `pnpm --filter @miniapp/admin build` for broad UI/platform changes.
