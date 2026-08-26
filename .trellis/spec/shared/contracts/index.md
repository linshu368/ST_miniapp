# Shared Contracts Guidelines

Applies to `packages/shared`.

## Pre-Development Checklist

- Inspect existing `packages/shared/src/api/*` contract files for naming, envelope, and zod/type patterns.
- Read `docs/ARCHITECTURE.md` section 3.1.
- For cross-layer features, read `.trellis/spec/guides/cross-layer-thinking-guide.md`.

## Required Rules

- Shared API contracts are the source of truth for cross-package request/response shapes.
- Do not define public API DTOs privately in `backend`, `frontend`, `admin`, or `cs-platform`.
- Keep runtime-safe modules browser-safe unless the file is explicitly server-only.
- Do not re-export server-only dependencies from `packages/shared/src/index.ts`.
- Add focused tests when contract helpers include behavior.

## Quality Check

- Run `pnpm --filter @miniapp/shared typecheck`.
- Run `pnpm --filter @miniapp/shared test` when touching contract helpers or shared utilities.
- Check all consumers compile after changing exported types.
