# CS Platform Guidelines

Applies to `packages/cs-platform`.

## Pre-Development Checklist

- Read `docs/ARCHITECTURE.md` sections 3, 6, and 7.
- Inspect existing CS API helpers, components, and auth token usage.
- For backend changes, read `.trellis/spec/backend/app/index.md`.

## Required Rules

- Vite + React patterns.
- CS APIs use existing `X-CS-Admin-Token` / operator headers.
- Consume shared contracts where available.
- Do not import application packages.
- Preserve current operational workflow unless PRD explicitly changes it.

## Quality Check

- Run package typecheck/test commands if present.
- For cross-layer changes, verify backend route contract and CS caller together.
