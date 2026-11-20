# Implementation and verification

1. Extract VoiceBar; add bounded native-audio lifecycle, inline failure/retry and safe Sentry reporting.
2. Add regression tests: play policy rejection, sync throw, pending play timeout, media codes, initial preload error, duplicate paths, retry, progress, hidden/resume, pause/takeover/dispose and telemetry failure/privacy.
3. Run pnpm --filter @miniapp/frontend test; typecheck; lint; build; pnpm lint:complexity; pnpm lint:imports; git diff --check. Preserve any existing .next/standalone junction tree by a checked move before build, per frontend spec.
4. Review source/data flow and update conversation UI spec and investigation record. Confirm no new fetch, generation call, business ID or URL in telemetry.
5. Manual acceptance: Android/iOS Telegram play/pause/seek/switch/leave; blocked/invalid resource/retry; background return without false timeout. Local browser fixtures cannot prove actual sound or OS audio routing. Recommend extending existing packages/ui-tests @chat fixture coverage; do not create a parallel mock server.
6. Record check outcomes and unrun device/release/P95 validation. No commit, push or deployment requested.
