# Preset Platform Backend 基座

## Goal

实现内部路由、Admin 账号鉴权复用、平台授权、环境指纹、CORS/feature flag、基础 repositories。

## Requirements

- 新增 Preset Platform 内部 route/feature/repository 骨架，路径统一在 `/api/internal/preset-platform/*`。
- 复用 Admin Supabase 账号/角色表做登录身份来源，测试和生产环境同口径；Preset Platform 授权关系独立归属 `preset_platform`。
- 实现 operator auth、角色权限映射、环境 fingerprint、CORS `PRESET_PLATFORM_URL`、feature flag、限额基础设施和 Pino allowlist 日志。
- Route 只做鉴权、shared 契约解析、feature 调用、HTTP/SSE 映射和摘要日志；每条注册保留 `@frontend-ready`。
- Repository 不暴露数据库 row，不把 Preset Platform 业务对象放入 `admin` schema。
- 本任务交付基础鉴权、配置、路由注册和 CRUD 骨架，不实现模型生成和素材脱敏主逻辑。

## Acceptance Criteria

- [ ] `/me` 返回环境指纹、operator opaque id、角色权限和功能开关。
- [ ] 未登录、角色不足、环境 mismatch、feature flag off、CORS 未放行均有稳定错误。
- [ ] 基础会话/预设/草稿/默认发布 route 可以按 shared 契约解析并调用 repository stub 或已实现 DB 方法。
- [ ] 日志不包含 token、Supabase session、消息正文或用户身份原文。
- [ ] `pnpm --filter @miniapp/backend typecheck` 和相关 backend tests 通过。
- [ ] 根据实现补充 `.trellis/spec/backend/app/*`，必要时更新 backend module facts。

## Notes

- 依赖 shared 契约和数据库域子任务。
- 生成、模型目录和素材脱敏分别由后续 backend 子任务完成。
