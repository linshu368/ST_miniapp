# Design and planning review

## Reuse research

Reuse ChatMessageVoiceFooter and its existing ready audio URL, existing Sentry sendSentryLog/withScope, and getMetricDimensions. Follow drama-media lifecycle/failure classification but do not reuse its video-specific frame/HLS controller. Existing voice API mutation already reports failed HTTP requests; no new backend endpoint, database function, repository or shared contract is needed. React Query and voice billing stay unchanged.

## Minimum sufficient implementation

Extract the audio bar into chat-voice-bar.tsx and put its event lifecycle in adjacent voice-playback.ts. Keep one player ownership in that domain module. A small adjacent voice-playback-report.ts safely projects bounded state and emits existing Sentry logs plus grouped warnings. Avoid a general media framework or new dependencies. Native element events remain the source of playing/progress/duration state.

## Reliability

One explicit attempt, no automatic retry. Play remains synchronous within a click gesture. Reload only on explicit retry after error. A 15-second foreground watchdog covers hung play/loading and later buffering; progress resets it. Hidden pages clear it; visible pending attempts rearm with a fresh foreground budget. Pause, takeover and disposal invalidate attempts before pause, so late promises cannot report failures or revive state. One failure per attempt deduplicates error and rejected promise; preload error reports once until explicit retry. Logging issues are rate-limited by a finite reason map to one per reason/minute while per-attempt logs preserve investigation sequence. Telemetry exceptions are isolated. No transaction/idempotent writes, compensation, external-call retries or new server capacity are involved.

## Privacy and correlation

Use finite reason/stage/outcome, media numeric states, elapsed/current time, muted/volume/playback rate and OS/network dimensions only. No URLs, raw error strings, content or new business IDs. Existing Sentry SDK account/release/device/trace context correlates events, and existing API request/trace IDs correlate generation HTTP separately. Browser playback errors are not Railway server facts. No new alert policy; existing Sentry visibility only.

## Evolution and recovery

No migration or API compatibility changes. Ship frontend normally after checks; verify Android/iOS existing MP3 playback and retry online. Roll back these frontend files if playback regresses; existing generated files and billing remain valid. Stop release if tests expose stale playback, incorrect charge/regeneration, raw URL logging or unbounded events. Manual system mute/Bluetooth routing cannot be diagnosed as an audio decode failure.

## Review

Planning reviewed against repository specs and the prior findings on 2026-11-20. Scope authorized by the user's follow-up to implement handling and failure records. Regression tests are required by the explicit async-race/privacy risk assessment above. No delegation needed.
