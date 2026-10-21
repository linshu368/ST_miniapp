# GHCR consumer audit

Date: 2026-10-20

Decision: remove `.github/workflows/build-and-push.yml`. The workflow is an active image producer, but the repository's controlled deployment paths have no GHCR consumer.

## 1. Repository references

- `git grep` on both `origin/dev` and `origin/main` found `ghcr.io`, `st-miniapp-backend`, `st-miniapp-frontend`, and `build-and-push` only in the producer workflow and documentation describing that workflow.
- No Compose file, runtime configuration, deploy workflow, shell script, package script, or application source pulls either current image.
- `ci.yml` builds the Backend Dockerfile with `push: false`; it validates the image and does not consume a published tag.
- `Dockerfile.frontend` remains a local full-stack simulation artifact. It does not require a registry image.

## 2. Railway and Vercel deployment path

- `.railway/railway.ts` declares every active Railway service with `source: github(REPOSITORY, { branch })` and `dockerfilePath: /ops/docker/Dockerfile.backend`. No service declares an image source.
- `ops/railway/README.md` requires Railway services to connect to `linshu368/ST_miniapp`, using `dev` for development and `main` for production.
- GitHub deployment records show current Railway development/production and Vercel preview/production deployments attached directly to repository commit SHAs. For example, commit `c2796ed96e20416329cb203d026f0e1c184ca274` produced Railway and Vercel deployment records immediately after the `dev` push; the production deployment is attached to `main` commit `ca44cd17ff6a31392340165fba8a618da1d4c4a1`.
- No current Railway or Vercel path requires a GHCR tag handoff.

## 3. Remote branches, tags, packages, and workflow history

- `git ls-remote --heads --tags origin` found no `staging-*` tag. The only remote tag was `id-fork-baseline`, so the workflow's Frontend staging trigger has no current release path.
- Anonymous GHCR registry inspection found four old tags for `st-miniapp-frontend`, all from the former `dev_stage5_m5-registry` path, and no staging tag.
- `st-miniapp-backend` contained 346 tags, including `dev-latest` and `sha-c2796ed`. These are producer artifacts; no repository or deployment configuration references them.
- The latest 100 `Build and Push Images` runs were all `dev` push events: 94 succeeded and 6 were cancelled. The latest successful run was `39378860466` for `c2796ed`, taking about four minutes. No downstream job or deployment consumes its output.
- GitHub issue search found no `ghcr.io` reference, and the repository has no releases referring to these images.

The authenticated GitHub token did not have `read:packages`, so package-version metadata and download analytics were unavailable. The public registry does allow anonymous pulls, which means unknown third-party pulls cannot be disproved. They are not a supported application deployment path and no repository contract advertises them. This limitation does not justify continuing an otherwise unconsumed build on every `dev` push.

## Result

Deleting the workflow stops future GHCR publication without changing CI image validation, Vercel deployment, Railway deployment, local Docker builds, or existing package artifacts. Existing GHCR packages can be archived or deleted separately after any desired rollback retention window.
