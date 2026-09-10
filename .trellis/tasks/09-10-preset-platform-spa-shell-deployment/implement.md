# Preset Platform SPA 基座与部署实施计划

## 顺序

1. 参考 Admin/CS Platform 的 Vite、AntD、环境、Vercel 配置和 CI 口径。
2. 新增 `packages/preset-platform` workspace 包、脚本、Vite、TS、Vitest、AntD、Router、React Query。
3. 实现环境模块、Supabase client/session 生命周期、auth guard、workspace layout、error boundary、统一 API/SSE client。
4. 支持 test/prod 成组切换，缺变量 fail fast，Preview 默认只连 test。
5. 新增 `packages/preset-platform/vercel.json`，不新增 Railway frontend service、Dockerfile 或 GHCR 镜像。
6. 更新 CI：新增 preset-platform test/build；Railway backend env/CORS 补 `PRESET_PLATFORM_URL`。
7. 新增 `.trellis/spec/preset-platform/app/*` 初版，并更新 README/ARCHITECTURE 部署口径。

## 验证

```bash
pnpm --filter @miniapp/preset-platform typecheck
pnpm --filter @miniapp/preset-platform test
pnpm --filter @miniapp/preset-platform build
pnpm -r typecheck
pnpm lint:imports
```
