# Voice playback recovery and failure diagnostics

## Requirements

- Show a readable inline message when audio play is rejected, loading/decoding fails, or foreground playback makes no progress for 15 seconds.
- Retry the existing audio only on an explicit user gesture; never regenerate or charge automatically.
- Record bounded, privacy-safe playback diagnostics in existing Sentry logs/issues, using existing account/release/device context for investigation.
- Keep one audio playing at a time and clean up on source change/unmount; old promises cannot change the new playback state.
- Preserve generation, billing, shared API and server behavior. This closes an observability gap, without claiming the earlier incident root cause is proven.

## Acceptance

- Rejected play, media network/decode/unsupported errors, initial load error and foreground no-progress timeout show actionable inline hints.
- Pause, another player taking over, background suspension and disposal do not become playback failures.
- Duplicate media-error/play rejection produces one failure per attempt; explicit retry can recover.
- Telemetry excludes source URLs, raw errors/messages, audio IDs, message IDs and content. Monitoring failure cannot break playback.
- Reviewed risk decision: add a focused regression test file for async races, timeout/background behavior, privacy projection and retry. Run existing frontend tests, typecheck, lint, build and complexity checks.

## Performance

Scope: /chat/:characterId. No API changes or added requests. Android/iOS page P95 baseline unavailable for this precise scope/release; do not infer from the single investigation request. Target remains 4000ms page P95. After release compare each OS independently over 48h and verify failures/recovery; no fixed-sample performance gate is required.

User steering: preserve the current controls and layout; failure-only short inline text, no modal or new controls.
