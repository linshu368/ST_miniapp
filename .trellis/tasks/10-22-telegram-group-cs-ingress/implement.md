# Implementation and validation

1. Review planning, start task, create feature branch from dev.
2. Define shared DTO before producer; extend centralized environment config and existing CS HTTP helper.
3. Add group branch before /start, strict private isolation, anonymous sender handling and retryable group failure.
4. Extend existing webhook regression tests and add CS-client contract/error tests.
5. Update README/ARCHITECTURE and prepare module-updates payload.
6. Run shared tests, backend tests, pnpm -r typecheck, import/legacy lint, git diff --check and applicable build. Backend/shared have no build scripts.
7. Manual TEST scenarios when CS receiver exists: group text/photo/start/edit/duplicate, disabled switch, unreachable receiver and private text/start. No production credentials or group interactions now.
8. Deliver final paths/diff/digest and validation to root for review before publication; no merge/deploy/webhook registration.

Failure coverage: disabled/empty/wrong allowlist, invalid ID/date, channel, private edits, sender_chat fake user, CS timeout/status/error envelope, group503 versus private200.
