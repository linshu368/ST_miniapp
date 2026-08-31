# syntax=docker/dockerfile:1

# =============================================================================
# backend: @miniapp/backend — single Fastify process (HTTP API + ST reverse proxy).
#
# Inherited from M1 (ops/docker/Dockerfile.st-bundle, hard constraints):
#   - base: node:20-bookworm-slim (matches .nvmrc=20; glibc)
#   - corepack pnpm@9.15.9 (matches root packageManager field; version now via ARG PNPM_VERSION,
#     provisioned explicitly in the stable layer rather than implicitly on pnpm's first call)
#   - pnpm install --frozen-lockfile, dependencies installed INSIDE the image
#   - ARG TARGETARCH (keeps buildx cross-platform builds working)
#   - multi-stage builder -> runtime; runs as the base image's non-root `node` user
#   - NODE_ENV=production; no extra TZ/locale (kept identical to M1)
#
# Differences from M1 (driven by backend reality, verified against source):
#   - Single process => `tini` as PID 1 + HEALTHCHECK via wget (no s6-overlay).
#   - @miniapp/backend has NO build step and consumes its workspace dep @miniapp/shared as
#     TS *source* (shared "main" = src/index.ts). Plain `node dist/...` cannot load the TS
#     workspace dep, so the runtime transpiles on the fly with tsx (same rationale M1 used
#     for sync-engine). tsx is a devDependency, so instead of shipping the full dev install
#     (which drags in shared's vitest/vite/rolldown test tooling, ~100MB+ of non-runtime weight)
#     we install PROD-ONLY deps and add tsx as a small, self-contained global transpiler.
#   - Prisma client is generated at BUILD time via `pnpm dlx prisma` (the CLI is a devDep, so it
#     is fetched ephemerally rather than shipped). openssl is installed so Prisma selects the
#     correct native engine for the platform. The runtime needs no `prisma` CLI / startup codegen.
#   - Port is NOT hard-coded: source reads process.env.PORT (default 3001); exposed via ENV and
#     the HEALTHCHECK resolves ${PORT:-3001} at runtime.
# =============================================================================

# Pin the toolchain versions so build-time fetches are deterministic.
# PNPM_VERSION must stay in lockstep with the root package.json "packageManager" field.
ARG PNPM_VERSION=9.15.9
ARG PRISMA_VERSION=6.19.3
ARG TSX_VERSION=4.21.0

# ========== Stage 1: builder (prod deps + generated prisma client) ==========
FROM node:20-bookworm-slim AS builder
ARG TARGETARCH
ARG PNPM_VERSION
ARG PRISMA_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Corepack must never wait on (or even consider) an interactive confirmation: a Docker build has
# no TTY, and leaving this unset made the download path the only thing standing between a build
# and a hang. See the corepack note below.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# openssl: let Prisma detect the right libssl (bookworm = openssl-3.0.x) when generating.
#
# `corepack prepare` belongs in THIS layer, not in the `pnpm install` layer below. The pnpm
# tarball fetch used to happen implicitly on pnpm's first invocation — i.e. inside a layer that
# every source change invalidates, so it re-downloaded on essentially every build. On 2026-08-28
# that fetch stalled on a Railway Metal builder and hung the production build twice (~20 min each,
# see docs/schema划分-批次A进度交接.md §12.5). Here the layer's only inputs are the base image and
# PNPM_VERSION, so the tarball is fetched once and then cached across all subsequent builds.
#
# `timeout ... || retry` matters because the observed failure was a STALL, not an error: without a
# timeout there is nothing to fail and retry, the build just hangs until someone notices.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && (timeout 180 corepack prepare "pnpm@${PNPM_VERSION}" --activate \
     || timeout 180 corepack prepare "pnpm@${PNPM_VERSION}" --activate) \
 && pnpm --version

WORKDIR /build
# Workspace metadata + only the packages in the backend dependency closure.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/backend packages/backend
COPY packages/shared  packages/shared

# If ARG PNPM_VERSION ever drifts from the root "packageManager" field, corepack would silently
# fetch the package.json version at `pnpm install` time — putting the download back into the layer
# that source changes invalidate, i.e. re-opening the hang. Fail loudly here instead.
RUN want=$(node -p "require('./package.json').packageManager") \
 && test "$want" = "pnpm@${PNPM_VERSION}" \
    || { echo "packageManager=$want != ARG PNPM_VERSION=pnpm@${PNPM_VERSION}; bump both" >&2; exit 1; }

# Production dependencies only (backend + its workspace dep @miniapp/shared). This excludes
# devDependencies (tsx, prisma CLI, typescript, and shared's vitest/vite tooling).
# --ignore-scripts: skip the root `prepare: husky` hook (husky is a root devDep, absent in a
# prod install) and @prisma/client's postinstall warning; the client is generated below via dlx.
RUN pnpm install --frozen-lockfile --filter @miniapp/backend... --prod --ignore-scripts

# Generate the Prisma client into the (prod) @prisma/client for this platform's native engine.
# The prisma CLI is a devDep; fetch it via `npx` (npm's isolated _npx cache) rather than
# `pnpm dlx` — dlx re-resolves the pnpm workspace and would pollute node_modules with the CLI,
# typescript and other dev-only packages (~100MB). npx writes nothing into node_modules.
RUN cd packages/backend && npx --yes prisma@${PRISMA_VERSION} generate

# Trim Prisma runtime weight we never use: source maps + the per-database query engine/compiler
# WASM blobs, keeping ONLY postgresql (the schema datasource). Whitelist form (delete everything
# that is NOT postgresql*) so a future Prisma bump that adds new providers stays trimmed.
# NOTE: revisit this trim logic whenever Prisma is upgraded (file layout may change).
RUN PC=$(ls -d /build/node_modules/.pnpm/@prisma+client@*/node_modules/@prisma/client) \
 && find "$PC"/runtime -type f -name '*.map' -delete \
 && find "$PC"/runtime -type f -name 'query_engine_bg.*.wasm-base64.*'   ! -name 'query_engine_bg.postgresql.*'   -delete \
 && find "$PC"/runtime -type f -name 'query_compiler_bg.*.wasm-base64.*' ! -name 'query_compiler_bg.postgresql.*' -delete

# Drop @prisma/client's optional PEER packages that pnpm auto-installs but the client never
# imports at runtime: the `prisma` CLI -> @prisma/config -> effect -> fast-check, plus the
# `typescript` peer (~110MB total). Removing their virtual-store dirs leaves only harmless
# dangling peer symlinks. (Codegen above already ran via npx.)
RUN rm -rf \
      /build/node_modules/.pnpm/prisma@* \
      /build/node_modules/.pnpm/@prisma+config@* \
      /build/node_modules/.pnpm/effect@* \
      /build/node_modules/.pnpm/fast-check@* \
      /build/node_modules/.pnpm/pure-rand@* \
      /build/node_modules/.pnpm/c12@* \
      /build/node_modules/.pnpm/jiti@* \
      /build/node_modules/.pnpm/typescript@*

# Build-time assertions: generated prisma client must exist.
RUN test -f /build/packages/backend/node_modules/@prisma/client/default.js

# ========== Stage 2: runtime ==========
FROM node:20-bookworm-slim
ARG TSX_VERSION

# tini -> proper PID 1 (signal forwarding + zombie reaping for a single Node process);
# wget -> HEALTHCHECK probe; openssl -> Prisma native engine needs libssl at runtime.
# node:20-bookworm-slim ships none of these.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini wget openssl \
 && rm -rf /var/lib/apt/lists/* \
# tsx as a self-contained global transpiler (resolves + transpiles the TS source at runtime,
# including the @miniapp/shared workspace dep). Kept out of the app node_modules on purpose.
 && npm install -g tsx@${TSX_VERSION} \
 && npm cache clean --force

ENV NODE_ENV=production
# Default listen port (source: process.env.PORT || 3001). Overridable at runtime (ENV pass-through);
# the port is never written literally into the start command.
ENV PORT=3001

WORKDIR /home/node/app

# backend source (+ prisma schema/generated client) and its workspace dep, plus the prod-only
# pnpm node_modules topology (root .pnpm store + packages/*/node_modules relative symlinks).
# --chown sets ownership at copy time (a separate `chown -R` would duplicate every file into an
# extra image layer, ~75MB of bloat).
COPY --from=builder --chown=node:node /build/packages/backend /home/node/app/packages/backend
COPY --from=builder --chown=node:node /build/packages/shared  /home/node/app/packages/shared
COPY --from=builder --chown=node:node /build/node_modules     /home/node/app/node_modules

WORKDIR /home/node/app/packages/backend
USER node

# Informational; actual listen port follows $PORT.
EXPOSE 3001

# Single-process HTTP healthcheck against the in-source /health route (resolves $PORT at runtime).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3001}/health" >/dev/null 2>&1 || exit 1

# tini as PID 1 (forwards signals to / reaps the tsx+node process tree). The long-running
# process matches scripts.start's server; Sentry preloads before Fastify/Pino/Prisma imports.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["tsx", "--import", "./src/instrumentation.ts", "src/server.ts"]
