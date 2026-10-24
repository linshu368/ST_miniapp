# Validation — 2026-10-22

- Full backend existing + ingress tests: 92 suites / 737 tests passed after Prisma client generation. A subsequent focused rerun includes the additional allowed-group /start + 4096→4000 contract regression.
- Shared: 16 suites / 169 tests passed.
- `corepack pnpm -r typecheck`: shared/backend/reply-renderer/admin/frontend passed.
- Import boundary lint, legacy guard, module-knowledge check and git diff --check passed.
- Admin production build passed; existing large-bundle warning remains.
- Frontend build attempted and blocked before compilation by sandbox runtime: Node process.memoryUsage failed ENOENT uv_resident_set_memory because /proc is unavailable. No frontend implementation changed; frontend typecheck passed.
- Backend/shared expose no build script. Prisma generated locally without DB access. Temporary pnpm11 allowBuilds placeholders were reverted; manifests and lockfile unchanged.
- No provider, database, Telegram group, CS live endpoint, deployment or webhook registration calls were made.
- Pending manual TEST acceptance: CS persisted receipt, duplicate delivery/edit ordering, real Bot visibility and DM permission. Both switch and allowlist stay unconfigured/disabled.
