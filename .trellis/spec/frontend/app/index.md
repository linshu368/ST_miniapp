# Frontend App Guidelines

Applies to `packages/frontend`.

## Pre-Development Checklist

- Read `docs/frontend-rules-template.md`.
- Read `docs/ARCHITECTURE.md` sections 1, 3, 4, and 7.
- Search existing code in `packages/frontend/src/lib/api`, `components`, `stores`, and `app`.
- If the change spans backend/API/database, also read `.trellis/spec/guides/cross-layer-thinking-guide.md`.

## Required Rules

- Next.js 14 App Router and React 18 function components.
- Server data goes through React Query hooks in `src/lib/api/`.
- Components must not call `fetch` or `axios` directly.
- Local state uses `useState`; cross-component state uses Zustand.
- Forms use React Hook Form + Zod.
- Styles use Tailwind and existing shadcn/ui components. Do not add local CSS files except global style entrypoints.
- Do not use DB row types in frontend.
- Do not change UX, copy, layout, or visual style unless the PRD explicitly asks for it.

## Quality Check

- Run `pnpm --filter @miniapp/frontend typecheck` for TypeScript changes.
- Run `pnpm --filter @miniapp/frontend test` when touching logic with existing tests or adding behavior.
- For visual/UI changes, inspect mobile and desktop states before delivery.
