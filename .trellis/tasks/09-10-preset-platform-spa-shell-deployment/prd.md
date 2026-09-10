# Preset Platform SPA 基座与部署

## Goal

创建 packages/preset-platform、环境切换、登录壳、Vercel/CI/Railway env 配置。

## Requirements

- 新增 `packages/preset-platform` / `@miniapp/preset-platform`，使用 Vite React、TypeScript strict、AntD、React Router、TanStack React Query、Supabase JS、Zod、Vitest。
- 建立 app providers、router、layout、auth guard、error boundary、统一 API/SSE client、Supabase client 生命周期和环境模块。
- 支持 test/prod 成组环境切换：API URL、Supabase URL/anon key、session、Query cache、SSE request 和环境指纹一起切换；缺变量则对应环境不可选。
- 默认进入 test；Vercel Preview 默认只连 test 和 preview/development backend。
- 部署参考 Admin/CS Platform：独立 Vercel 静态 SPA，包内 `vercel.json`，不部署到 Railway，不新增 Docker/GHCR 镜像。
- CI 增加新包 test/build；Railway 只补 backend CORS/env `PRESET_PLATFORM_URL` 和 PR backend 对齐。

## Acceptance Criteria

- [ ] 新包可 `pnpm --filter @miniapp/preset-platform dev/typecheck/test/build`。
- [ ] 未配置环境变量时 fail fast，不回退 production。
- [ ] 环境切换会清理 Query cache、敏感 UI 和旧 Supabase client/session，不串环境。
- [ ] `packages/preset-platform/vercel.json` 与 Vercel Root Directory/outputDirectory 口径明确。
- [ ] `.github/workflows/ci.yml` 覆盖新包 test/build；`.railway/railway.ts` 不新增前端 service。
- [ ] 新增 `.trellis/spec/preset-platform/app/*` 初版，并更新 README/ARCHITECTURE 的部署口径。

## Notes

- 该任务 package 暂标 `frontend` 是因为 Trellis 白名单尚无 `preset-platform`；实际目标是新增独立 workspace 包。
