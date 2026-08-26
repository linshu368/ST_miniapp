<!-- TRELLIS:START -->

# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (`task.json`, `prd.md`, `design.md`, `implement.md`)

If a Trellis command is available on your platform, prefer it over manual steps. Not every platform exposes every command.

If you are using Cursor, Trellis skills live in `.cursor/skills/trellis-*`.

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

## ST_miniapp Project Rules

Use Trellis for non-trivial work:

1. Create a task under `.trellis/tasks/` with `python ./.trellis/scripts/task.py create "<title>" --slug <slug>`.
2. Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
3. For complex tasks, create `design.md` for technical design, `implement.md` for the execution plan, and `task.md` for the executable task breakdown before `task.py start`.
4. Do not write product code before planning artifacts are reviewed and the task is moved to `in_progress`.
5. Use `implement.jsonl` and `check.jsonl` to list relevant spec/research files when dispatching sub-agents.

Project-specific hard rules:

- Package manager: `pnpm`; runtime: Node.js `>=22`.
- TypeScript strict mode; do not add `any`.
- External data contracts must be defined in `packages/shared/src/api/*` before backend handlers or frontend consumers.
- `frontend`, `backend`, `admin`, and `cs-platform` must not import each other; cross-application calls use HTTP.
- Frontend/admin/CS code must not consume database row types directly.
- Frontend server data must go through `src/lib/api/` React Query hooks, not component-level `fetch`.
- Every Fastify route registration must keep a nearby `@frontend-ready: true|false` comment.
- LLM generation and billing must go through `packages/backend/src/features/generation/`.
- Runtime config must be read through `packages/backend/src/platform/runtime-config.ts`.
- Database migrations live in `packages/shared/migrations/` and are manually executed; production migrations require test-first validation and rollback notes.
- Server logs use the existing pino conventions. Log original errors as `{ err }`, not `String(err)`.

Before implementation, read the relevant specs from `.trellis/spec/` plus the source docs they cite.
