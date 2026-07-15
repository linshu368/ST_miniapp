# ops — container images & deploy assets

Build/run notes for the images under `ops/docker/`. All images use the same base
(`node:20-bookworm-slim`), pnpm `9.15.9` (via corepack / `packageManager`), `--frozen-lockfile`
installs, `ARG TARGETARCH` for buildx cross-platform builds, and run as the non-root `node` user.

Each image has its own ignore-file next to its Dockerfile (BuildKit prefers
`<dockerfile>.dockerignore` over the repo-root `.dockerignore`), so the builds don't interfere.

## 镜像清单（方案 Y：生产 vs 本地仿真）

> 对外域名绑 **Vercel**，前端作为边缘入口；Railway 只跑 `backend` / `st-bundle` / `nginx`
> 三个服务（拓扑见 [`railway/README.md`](./railway/README.md)）。

| 镜像                                 | Dockerfile                        | 生产部署在                               | CI 构建                            |
| ------------------------------------ | --------------------------------- | ---------------------------------------- | ---------------------------------- |
| `st-miniapp-backend`                 | `ops/docker/Dockerfile.backend`   | **Railway**                              | 每次推送                           |
| `st-miniapp-st-backend`（st-bundle） | `ops/docker/Dockerfile.st-bundle` | **Railway**                              | 每次推送                           |
| `st-miniapp-nginx`                   | `ops/nginx/Dockerfile`            | **Railway**（envsubst 模板，仅内部分发） | 每次推送                           |
| `st-miniapp-frontend`                | `ops/docker/Dockerfile.frontend`  | **❌ 非生产** — 生产在 **Vercel**        | **默认不构建**，仅 `staging-*` tag |

- **frontend 镜像非生产**：仅用于本地 `docker compose` 全栈仿真。生产前端在 Vercel，
  Railway 不部署它。CI（`.github/workflows/build-and-push.yml`）默认不构建该镜像，
  只有在打 `staging-*` tag 时才构建，避免无用 CI 时间与 GHCR 存储占用。
- nginx 生产配置为 envsubst 模板（前端在 Vercel，网关仅做 ST/backend 内部分发）；
  本地 compose 用 `ops/nginx/nginx.local.conf`（含前端兜底）。详见 [`nginx/README.md`](./nginx/README.md)。

---

## st-bundle (M1)

SillyTavern + provision-api + watcher in one container, orchestrated by s6-overlay (three longrun
services). See `ops/docker/Dockerfile.st-bundle`.

```bash
docker buildx build --platform=linux/arm64 -f ops/docker/Dockerfile.st-bundle -t st-bundle:m1 --load .
```

Ports: `8000` (ST), `9091` (provision-api), `9090` (watcher health). HEALTHCHECK probes ST + provision-api.

> Size is large (multi-hundred-MB) because it bundles ST, its Node deps, and the s6-overlay runtime —
> this is by design for the all-in-one bundle and out of scope for the slimmer single-service images.

---

## backend (M2)

`@miniapp/backend` — a single Fastify process (HTTP API + ST reverse proxy). See
`ops/docker/Dockerfile.backend` and `ops/docker/Dockerfile.backend.dockerignore`.

### Build

```bash
# arm64 (load into the local docker engine)
docker buildx build --platform=linux/arm64 -f ops/docker/Dockerfile.backend -t backend:m2 --load .

# amd64 cross-platform build (dry-run / CI validation, no load)
docker buildx build --platform=linux/amd64 -f ops/docker/Dockerfile.backend --target=builder \
  --progress=plain --output=type=cacheonly .
```

> **amd64 cross-platform verification.** The Dockerfile is arch-agnostic (`ARG TARGETARCH`, no
> hardcoded arch; pnpm/npm/Prisma resolve per-platform). The **arm64** image is fully built and
> validated locally (see acceptance below). The **amd64** build is validated on **CI native (amd64)
> runners** — the local dev loop here is arm64-native. A local QEMU-emulated amd64 `buildx` dry-run
> was attempted and got through the platform-specific `pnpm install --prod` step successfully, but
> was not taken to completion locally because emulated builds are slow and the local Docker
> environment was degraded at the time (full disk → corrupted containerd store). Gating amd64 in CI
> on a native runner rather than in the local arm64 dev loop is the intended setup.

Design notes (differ from M1 because the backend reality differs — see header comments in the Dockerfile):

- **No build step.** `@miniapp/backend` has no `build` script and consumes its workspace dep
  `@miniapp/shared` as TS _source_ (`shared` "main" = `src/index.ts`). Plain `node dist/...` cannot
  load that TS dep, so the container transpiles on the fly with **`tsx`** — the same rationale M1 used
  for sync-engine. `tsx` is a devDependency, so the image installs **prod-only** deps (avoiding
  `shared`'s vitest/vite test tooling, ~100MB) and adds `tsx` as a small **global** transpiler.
- **Prisma client** is generated at **build time** via `npx prisma generate` (the CLI is a devDep,
  fetched ephemerally; `pnpm dlx` is avoided because it re-resolves the workspace and pollutes
  `node_modules`). `openssl` is installed so Prisma can select the right engine.
- **Prisma peer pruning.** `@prisma/client` declares `prisma` (CLI) + `typescript` as peer deps that
  pnpm auto-installs (`prisma`→`@prisma/config`→`effect`→`fast-check`, ~110MB) but never imports at
  runtime; these are removed from the runtime image.
- **Prisma WASM trim (whitelist).** Only the **PostgreSQL** query-engine/compiler WASM is kept; the
  other four providers + source maps are deleted. **⚠️ Revisit this trim whenever Prisma is upgraded** —
  the runtime file layout / engine type may change (see the `find ... ! -name 'postgresql*'` step).

### Run

```bash
docker run --rm -p 18080:3001 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/db \
  -e SUPABASE_URL=https://<ref>.supabase.co \
  -e SUPABASE_SERVICE_ROLE_KEY=<key> \
  backend:m2
# -> GET http://127.0.0.1:18080/health  => 200 {"success":true,"data":{"status":"ok",...}}
```

- Listens on `0.0.0.0:$PORT` (default `3001`). The port is **not** hard-coded — set `-e PORT=...` to
  change it; `EXPOSE 3001` is informational and the HEALTHCHECK resolves `${PORT:-3001}`.
- `tini` is PID 1; **SIGTERM/SIGINT** trigger a graceful Fastify `close()` and exit `0`
  (`docker stop` returns in well under 1s).
- HEALTHCHECK: `wget -qO- http://127.0.0.1:${PORT:-3001}/health` (interval 30s, start-period 20s).

### Environment variables

Extracted from `packages/backend/src/**` (`process.env.*`) + `packages/backend/prisma/schema.prisma`.
"Required" = process fails to start / core path breaks without it; feature vars are only needed when
that feature is exercised.

| Variable                                           | Required                 | Default                                      | Purpose                                                                               |
| -------------------------------------------------- | ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                     | **Yes**                  | —                                            | Postgres connection for Prisma; `lib/db.ts` throws if unset.                          |
| `DIRECT_URL`                                       | Migrations only          | —                                            | Prisma `directUrl` (schema) — used by migrations, not by the client at query time.    |
| `PORT`                                             | No                       | `3001`                                       | HTTP listen port (`0.0.0.0`).                                                         |
| `NODE_ENV`                                         | No                       | `production` (image)                         | Runtime mode; also enables dev CORS bypass when not `production`.                     |
| `FRONTEND_URL`                                     | No                       | `http://localhost:3000`                      | Exact-match CORS origin for the frontend.                                             |
| `SUPABASE_URL`                                     | Bridge feature           | `''`                                         | Supabase service client URL (bridge st_handle reads/writes).                          |
| `SUPABASE_SERVICE_ROLE_KEY`                        | Bridge feature           | `''`                                         | Supabase service_role key (bypasses RLS).                                             |
| `SUPABASE_PROJECT_REF`                             | No                       | derived                                      | Project-ref isolation guard (`@miniapp/shared`).                                      |
| `DATABASE_ENV`                                     | No                       | from `NODE_ENV`/Railway                      | Selects test vs production DB target + isolation checks.                              |
| `PROD_SUPABASE_PROJECT_REF`                        | No                       | shared default                               | Expected prod project ref (isolation guard).                                          |
| `TEST_SUPABASE_PROJECT_REF`                        | No                       | shared default                               | Expected test project ref (isolation guard).                                          |
| `ALLOW_PROD_DATABASE`                              | No                       | unset                                        | Escape hatch to allow non-prod env → prod DB.                                         |
| `RAILWAY_ENVIRONMENT` / `RAILWAY_ENVIRONMENT_NAME` | No                       | unset                                        | Detected as `production` env when set to `production`.                                |
| `ST_BASE_URL`                                      | ST feature               | `http://localhost:8000`                      | SillyTavern base URL for bridge login + reverse proxy.                                |
| `ST_USER_PASSWORD_SECRET`                          | ST feature               | `''`                                         | Secret to derive per-user ST passwords (must match sync-engine).                      |
| `ST_PROVISION_URL`                                 | ST feature               | `http://127.0.0.1:9091`                      | sync-engine provision API URL.                                                        |
| `TELEGRAM_BOT_TOKEN`                               | No                       | `''`                                         | Telegram bot token (init-data verification path).                                     |
| `CS_TELEGRAM_BOT_TOKEN`                            | No                       | unused when `TELEGRAM_BOT_TOKEN` is set      | Compatibility fallback for CS outreach; the active MiniApp bot always takes priority. |
| `DEV_AUTH_BYPASS`                                  | Dev only                 | unset                                        | `=1` bypasses auth + relaxes CORS (non-prod).                                         |
| `MOCK_AUTH`                                        | Dev only                 | unset                                        | `=1` mocks auth (non-prod only).                                                      |
| `PAYMENT_ENABLED`                                  | No                       | `false`                                      | Enables the payment gateway (`=true`).                                                |
| `PAYMENT_MERCHANT_ID`                              | If payment               | `''`                                         | Payment merchant id.                                                                  |
| `PAYMENT_MERCHANT_KEY`                             | If payment               | `''`                                         | Payment merchant key/secret.                                                          |
| `PAYMENT_BASE_URL`                                 | If payment               | `http://jlusdt.com`                          | Payment gateway base URL.                                                             |
| `PAYMENT_NOTIFY_URL`                               | If payment               | `''`                                         | Async payment callback URL.                                                           |
| `PAYMENT_RETURN_URL`                               | If payment               | `''`                                         | Post-payment redirect URL.                                                            |
| `OPENAI_API_BASE_URL`                              | LLM feature              | `https://api.openai.com/v1/chat/completions` | Default AI channel endpoint.                                                          |
| `OPENAI_API_KEY`                                   | LLM feature              | `''`                                         | AI channel API key.                                                                   |
| `OPENAI_MODEL`                                     | LLM feature              | `gpt-3.5-turbo`                              | Default AI channel model.                                                             |
| `LLM_UPSTREAM_URL`                                 | LLM proxy                | `https://openrouter.ai/api/v1`               | Upstream for the `/api/.../llm-proxy`.                                                |
| `LLM_API_KEY`                                      | LLM proxy                | falls back to `OPENAI_API_KEY`               | LLM proxy upstream key.                                                               |
| `LLM_PROXY_TOKEN_SECRET`                           | LLM proxy                | falls back to `ST_USER_PASSWORD_SECRET`      | Secret to sign LLM proxy tokens.                                                      |
| `UPSTASH_REDIS_REST_URL`                           | Config store / ST cookie | unset                                        | Upstash Redis REST URL (runtime config + ST cookie cache).                            |
| `UPSTASH_REDIS_REST_TOKEN`                         | Config store / ST cookie | unset                                        | Upstash Redis REST token.                                                             |

### Image size

| Metric                                  | Value       |
| --------------------------------------- | ----------- |
| `docker save` tar (distributable)       | **~94 MB**  |
| `docker image inspect .Size`            | **~94 MB**  |
| `docker images` (uncompressed, on-disk) | **~433 MB** |
| base `node:20-bookworm-slim` alone      | **313 MB**  |

The 250MB soft target is not reachable: the **mandated `node:20-bookworm-slim` base is 313MB on its
own** (78% of the 400MB red line), and Prisma's client (incl. its WASM query engine, ~35MB) plus the
`tsx`+`esbuild` transpiler (~21MB, required because there is no build step) are irreducible runtime
needs — analogous to M1's size explanation. Under the distributable (`docker save`) metric the image
is ~94MB; the ~433MB figure is the uncompressed on-disk sum dominated by the fixed base layers.

### Known follow-ups (M4)

- Prisma currently ships the **WASM** query engine (no native `libquery_engine` binary was emitted);
  verify real queries against a live `DATABASE_URL` during M4 integration (and re-check whether the
  native engine + `openssl` would be preferable).
- Real cross-service wiring (nginx / ST container / Supabase credentials) is M4, not validated here.
