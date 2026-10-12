# 根治 Admin Preview API 映射失效

## Goal

Prevent an Admin Vercel Preview from publishing or presenting a generic login
network error when its TEST/PR Railway API mapping is invalid or unreachable.

## Requirements

- Keep Admin's existing trust boundary: the browser calls the Backend
  `/api/admin/supabase` proxy, never Supabase directly.
- Resolve a normal branch Preview to the configured stable TEST API; resolve a
  pull-request Preview only to that PR's deterministic Railway API origin.
- Reject invalid Preview API configuration during the Vite build with an
  actionable error. It must never fall back to Production.
- Add an automated, credential-free validation of the deterministic PR API
  mapping: the expected backend must answer health and accept a controlled
  Vercel Preview origin on the Admin proxy preflight before the Preview is
  treated as usable.
- When a previously deployed Preview loses its ephemeral PR backend, show a
  precise unavailable-environment state instead of `TypeError: Failed to fetch`.
- Do not read, log, commit, or expose credentials. Do not change database
  schemas, login semantics, or Production configuration.

## Acceptance Criteria

- [x] Resolver tests cover stable branch Preview, valid PR Preview, malformed
      PR metadata, missing TEST API configuration, and Production non-fallback.
- [x] An invalid Preview configuration fails `pnpm --filter @miniapp/admin build`
      with the variable/mapping that must be fixed.
- [x] The automated smoke check uses only `/health` and an unauthenticated
      OPTIONS request to the Admin Supabase proxy; it verifies the exact origin,
      status, and required CORS headers without sending an anon key or login data.
- [x] An unavailable API is rendered as a recoverable, operator-actionable
      Admin login error and does not submit credentials.
- [x] Existing Admin typecheck, tests, build, and relevant workflow validation pass.

## Notes

- Diagnosis evidence on 2026-10-12: the stable TEST backend was healthy and
  returned an exact CORS allow-origin for the reported Vercel URL; the browser
  still failed before an Admin proxy request reached that backend. The actual
  build-injected API base remains unverified, so this task prevents the whole
  configuration/reachability class rather than asserting one cause.
