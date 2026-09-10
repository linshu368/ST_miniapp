# Preset Platform Shared 契约

## Goal

定义 Preset Platform 跨包 API/SSE/错误码/Zod 契约，先于 backend 和 SPA 实现。

## Requirements

- 新增 `packages/shared/src/api/preset-platform.ts`，定义 Preset Platform 的请求、响应、分页、错误码和 SSE 事件契约。
- 覆盖会话、消息、模型目录摘要、预设 V1、草稿、发布/回滚、当前环境角色摘要、脱敏输入样本、环境指纹和 `/me` 权限信息。
- 预设 V1 只支持单段 `systemInstruction` 与采样参数白名单；不支持 ST payload、宏、世界书、正则脚本或任意 provider JSON 透传。
- 所有外部输入使用 Zod 做 runtime validation；DTO 不暴露数据库 row、service-role、OpenRouter key、原始用户身份或未脱敏正文。
- SSE 使用稳定 discriminator，至少包含 `start | delta | done | error`，consumer 对未知事件可安全忽略。
- 契约变更必须保持兼容扩展；破坏性变更需要版本化或双读过渡。
- 本任务只处理 shared 契约，不实现 backend route、数据库 migration 或 SPA 页面。

## Acceptance Criteria

- [ ] `@miniapp/shared` 导出 Preset Platform 契约，backend 和新 SPA 可类型安全消费。
- [ ] 关键 schema 有正反向测试，覆盖无效 preset、非法采样参数、分页边界、错误码和 SSE event。
- [ ] `pnpm --filter @miniapp/shared typecheck` 通过。
- [ ] `pnpm --filter @miniapp/shared test` 通过。
- [ ] 至少运行受影响消费者 typecheck，或记录不能运行的原因。
- [ ] 根据实现补充 `.trellis/spec/shared/contracts/*`，必要时更新 shared 模块事实和父任务记录。

## Notes

- 父任务：`.trellis/tasks/09-07-preset-dialogue-platform-planning`。
- 下游依赖：数据库、backend、SPA 子任务均应以本契约为边界。
