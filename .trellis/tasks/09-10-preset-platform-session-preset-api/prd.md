# Preset Platform 会话预设 Backend API

## Goal

实现私有会话、预设库、私有草稿、平台默认发布/回滚的 backend API 与 repository 业务逻辑。

## Requirements

- 实现 Preset Platform 的核心 backend 业务 API：私有测试会话、预设库、当前操作者私有草稿、平台默认预设发布/回滚。
- API 统一位于 `/api/internal/preset-platform/*`，使用 shared 契约解析请求/响应，route 保留 `@frontend-ready`。
- 会话和草稿按 operator 私有；已发布预设和平台默认预设按角色权限可见/可应用。
- 支持会话创建、重命名、归档/删除、读取详情、更新模型/预设/角色绑定。
- 支持预设库查看、应用；草稿创建、编辑、重命名、覆盖确认、另存、删除和一键应用。
- 平台默认发布/回滚生成 immutable release，使用 expected revision 防并发，记录审计摘要和操作者。
- 本任务不实现 OpenRouter 生成流、不实现素材脱敏、不实现 SPA UI。

## Acceptance Criteria

- [ ] 会话/草稿私有过滤有 backend 和数据库/RLS 双重验证。
- [ ] 发布/回滚具备权限、幂等或防重复、expected revision、审计和 409 冲突返回。
- [ ] 应用预设只改变当前会话后续请求，不修改历史消息或其他会话。
- [ ] 401/403/404/409/422/429/5xx 映射稳定，错误不泄露 SQL 或敏感字段。
- [ ] `pnpm --filter @miniapp/backend typecheck` 和相关 backend tests 通过。
- [ ] 根据实现补充 `.trellis/spec/backend/app/*` 和 backend module facts；如契约变化，同步 shared spec。

## Notes

- 依赖 shared 契约、数据库独立域和 backend foundation。
