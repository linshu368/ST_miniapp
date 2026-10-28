# Move image plaza tables to media_plaza

## Goal

Move the eight existing image plaza tables from `experience` and
`miniapp_features` into the `media_plaza` schema and switch the backend to use
the new schema directly.

## Requirements

- Move the seven `experience.image_plaza_*` tables and
  `miniapp_features.image_plaza_likes` physically into `media_plaza`.
- Move the three image-plaza RPC implementations into `media_plaza` and update
  the two billing RPCs that contain schema-qualified image-plaza references.
- Update the backend repository, seed tools, domain schema registry, and related
  existing tests to access `media_plaza` directly.
- Do not leave old-schema compatibility views, wrapper RPCs, or backend aliases.
- Keep RLS and grants effective; do not grant image-plaza access to `anon` or
  `authenticated`.
- Include an M1-only rollback and separate TEST/PRODUCTION PostgREST exposure
  prerequisites.
- Do not add video tables, frontend/admin changes, or execute SQL against a
  remote database.

## Acceptance Criteria

- [ ] Exactly eight base tables exist in `media_plaza` after M1.
- [ ] No image-plaza tables or RPCs remain in `experience` or
      `miniapp_features` after M1.
- [ ] Every backend image-plaza database consumer targets `media_plaza`.
- [ ] The canonical and billing functions contain no stale old-schema table
      references.
- [ ] The rollback restores the original table/function placement and removes
      `media_plaza`, and refuses to run after video objects exist.
- [ ] Backend typecheck/current relevant tests and migration lint/static checks
      pass; TEST execution, row/grant/RLS checks,
      and application smoke tests are recorded as release-time validation because
      no remote database is modified in this task.

## Notes

- TEST and production are not assumed to be structurally identical.
- `packages/shared/migrations/` remains the only migration source.
- This is an intentionally incompatible cutover. While image-plaza traffic is
  paused, the release must run M1, expose the now-existing `media_plaza` schema,
  and immediately deploy the matching backend.
