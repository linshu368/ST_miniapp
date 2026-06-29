#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# m5-push.sh — local fallback for the GHCR build-and-push flow (M5).
#
# Mirrors .github/workflows/build-and-push.yml on a single host: builds the 4
# service images for linux/amd64,linux/arm64 and pushes them to GHCR with the
# same tag strategy (sha-<short> + <branch>-latest).
#
# Credentials come ONLY from the environment (never written to disk):
#   GHCR_USERNAME   GitHub username that owns / can write the package
#   GHCR_TOKEN      PAT (or GITHUB_TOKEN) with `write:packages` scope
#                   (GHCR_PAT / CR_PAT are also accepted as aliases)
#
# Optional overrides:
#   GHCR_OWNER      package namespace owner            (default: linshu368)
#   IMAGE_PREFIX    image name prefix                  (default: st-miniapp-)
#   PLATFORMS       buildx platforms                   (default: linux/amd64,linux/arm64)
#   REGISTRY        registry host                      (default: ghcr.io)
#   BUILDER_NAME    dedicated buildx builder name      (default: st-miniapp-m5)
#   PUSH            set to 0 to build without pushing   (default: 1)
#
# Usage:
#   export GHCR_USERNAME=linshu368
#   export GHCR_TOKEN=ghp_xxx        # write:packages
#   ./scripts/m5-push.sh
# =============================================================================

REGISTRY="${REGISTRY:-ghcr.io}"
GHCR_OWNER="${GHCR_OWNER:-linshu368}"
IMAGE_PREFIX="${IMAGE_PREFIX:-st-miniapp-}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER_NAME="${BUILDER_NAME:-st-miniapp-m5}"
PUSH="${PUSH:-1}"

# Accept a few common credential aliases without printing any of them.
GHCR_USERNAME="${GHCR_USERNAME:-${GITHUB_ACTOR:-}}"
GHCR_TOKEN="${GHCR_TOKEN:-${GHCR_PAT:-${CR_PAT:-${GITHUB_TOKEN:-}}}}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
docker buildx version >/dev/null 2>&1 || die "docker buildx is required (Docker 19.03+ / buildx plugin)"

[ -n "$GHCR_USERNAME" ] || die "GHCR_USERNAME (or GITHUB_ACTOR) is not set"
[ -n "$GHCR_TOKEN" ] || die "GHCR_TOKEN (or GHCR_PAT / CR_PAT / GITHUB_TOKEN) is not set"

# Resolve repo root so the script works from any cwd, and so build contexts match.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_ROOT" ] || die "must be run inside the git repository"
cd "$REPO_ROOT"

# Tag inputs: sha-<short> (immutable) + <branch>-latest (moving).
GIT_SHA_SHORT="$(git rev-parse --short=7 HEAD)"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
# Sanitize the branch into a valid docker tag (replace anything outside [A-Za-z0-9._-]).
SAFE_BRANCH="$(printf '%s' "$GIT_BRANCH" | tr -c 'A-Za-z0-9._-' '-')"
TAG_SHA="sha-${GIT_SHA_SHORT}"
TAG_BRANCH="${SAFE_BRANCH}-latest"

echo "==> Registry namespace : ${REGISTRY}/${GHCR_OWNER}/${IMAGE_PREFIX}<component>"
echo "==> Platforms          : ${PLATFORMS}"
echo "==> Tags               : ${TAG_SHA} , ${TAG_BRANCH}"
echo "==> Push               : ${PUSH}"

# Log in via stdin so the token never appears in argv / process list.
echo "==> Logging in to ${REGISTRY} as ${GHCR_USERNAME}"
printf '%s' "$GHCR_TOKEN" | docker login "$REGISTRY" --username "$GHCR_USERNAME" --password-stdin

# Ensure a buildx builder that supports multi-arch via QEMU exists.
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  echo "==> Creating buildx builder '${BUILDER_NAME}'"
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --bootstrap >/dev/null
fi
docker buildx use "$BUILDER_NAME"

# component | dockerfile | context | build_args (space-separated --build-arg pairs)
build_one() {
  local component="$1" dockerfile="$2" context="$3" build_args="$4"
  local image="${REGISTRY}/${GHCR_OWNER}/${IMAGE_PREFIX}${component}"

  echo ""
  echo "=============================================================="
  echo "  Building ${image}"
  echo "    file=${dockerfile} context=${context}"
  echo "=============================================================="

  local args=(
    buildx build
    --platform "$PLATFORMS"
    --file "$dockerfile"
    --tag "${image}:${TAG_SHA}"
    --tag "${image}:${TAG_BRANCH}"
    --provenance=false
    --sbom=false
    --cache-from "type=registry,ref=${image}:buildcache"
  )

  if [ "$PUSH" = "1" ]; then
    args+=(--push --cache-to "type=registry,ref=${image}:buildcache,mode=max")
  else
    # Multi-arch images can't load into the local daemon; without --push we can
    # only validate the build itself.
    args+=(--output type=cacheonly)
    echo "    (PUSH=0 -> build only, no push, no local load)"
  fi

  # build_args is an intentional word-split list of --build-arg pairs.
  # shellcheck disable=SC2086
  docker "${args[@]}" $build_args "$context"
}

# NEXT_PUBLIC_API_URL empty => same-origin relative URLs (correct behind nginx).
build_one frontend   ops/docker/Dockerfile.frontend   .          "--build-arg NEXT_PUBLIC_API_URL="
build_one backend    ops/docker/Dockerfile.backend    .          ""
build_one st-backend ops/docker/Dockerfile.st-bundle  .          ""
build_one nginx      ops/nginx/Dockerfile             ops/nginx  ""

echo ""
echo "==> Done. Pushed tags: ${TAG_SHA} and ${TAG_BRANCH}"
if [ "$PUSH" = "1" ]; then
  echo "==> Verify multi-arch manifests, e.g.:"
  echo "    docker buildx imagetools inspect ${REGISTRY}/${GHCR_OWNER}/${IMAGE_PREFIX}frontend:${TAG_SHA}"
fi
