# Verification and review

## Results

- Frontend full suite: 80 files / 925 tests passed with `pnpm --filter @miniapp/frontend exec vitest run --maxWorkers=2`; includes 15 new playback regression cases.
- Initial concurrent default-worker run: existing artifact-renderer.test.tsx beforeAll bundling exceeded its 10s budget. Re-running the complete suite with lower worker concurrency passed without changing test timeouts or product code.
- Frontend typecheck passed after typing test callback mocks explicitly.
- Frontend lint passed with existing unrelated image/hook warnings.
- Root import guard script has a Windows command quoting problem with its empty --rule override. Equivalent `pnpm exec eslint --no-eslintrc -c .eslintrc.json "packages/*/src/**/*.{ts,tsx}" --no-inline-config` passed.
- Complexity check passed; unrelated baseline growth warnings remain. New runtime files/functions stay within 500/120 lines.
- Backend logging static guard passed; no backend runtime changes.
- Logging planning gate, Prettier for changed runtime/tests and git diff whitespace check passed.
- Frontend production build passed (Next.js 14.2.35); only existing Browserslist/Tailwind/image/hook warnings. Existing standalone tree was preserved under ignored output/build-snapshots before building.

## Implementation review

Native audio remains authoritative; existing compact control classes, dimensions, seek, duration and regeneration callback remain. Only failure adds a short status line. URL-keyed mount and controller disposal isolate sources and reject late promises. Retry is explicit and replays existing audio, never calls generation APIs. Pending and mid-playback waits have a single 15s foreground watchdog; pause/takeover/end/dispose clear it, and background time does not spend its budget.

Logs use existing Sentry infrastructure and finite reasons/stages. Raw errors, source URLs, content and new business IDs never reach the reporter. Existing account/release/device context remains available. Errors in telemetry are caught; issue warnings are limited by finite reason/minute. Existing generation HTTP/Railway evidence is unchanged and remains separate from browser playback.

React/Vitest review: functional components and proper effect cleanup; source reset via key; no fetch in components; no dependency, shared API, database, billing or deployment changes. Focused EventTarget tests exercise real listener ordering, fake-time deadlines and stale promise behavior.

## Bug analysis

1. Root cause category: implicit assumption and missing observability contract. Handling a rejected play promise only by resetting a visual flag concealed actionable failure; media element errors had no consumer. This fixes that confirmed gap, without proving the earlier reported incident's cause.
2. Prior fixes: none claimed. No speculative provider or billing fix was made.
3. Prevention: bounded lifecycle controller, explicit recovery hint, safe diagnostics, deduplication and async-race/privacy regression cases implemented.
4. Broader scope: video has its own existing observer and was used as a reference, not replaced. New generic media frameworks or backend telemetry endpoints were rejected as unnecessary.
5. Knowledge capture: conversation-ui module spec now describes exact local-candidate contracts, error paths, privacy and remaining real-device boundaries. No template tree for these app-specific specs exists in this repository; no template sync was performed.

## Remaining verification

No production deployment or Sentry ingestion validation performed. Android/iOS Telegram actual sound, system mute/Bluetooth routes and new-release 48h P95 remain device/post-release checks. Existing @chat UI fixtures return empty voice lists and cannot exercise these playback failures. Recommend extending their existing voice fixture and chat group with ready/failure/retry scenarios for repeatable UI acceptance; do not create a parallel mock backend.

## Follow-up investigation

After deployment search Sentry `voice.playback.failed` or logs `voice.playback.*`, scoped to the reported user, release and time. Inspect reason, stage, media_error_code, ready_state/network_state, mute/volume/rate, visibility and elapsed_ms. A progress event means observed media time movement, not proof of audible system output. No new audio/message ID is added to telemetry.
