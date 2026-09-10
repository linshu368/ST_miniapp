# Preset Platform 集成灰度与文档

## Goal

完成全链路 test/prod 灰度、CI/Vercel/Railway 验证、README/ARCHITECTURE/spec 同步。

## Requirements

- 完成 Preset Platform 所有子任务后的全链路集成、灰度和文档同步。
- 覆盖 test 主路径、失败路径、隐私路径、零回写证明、Vercel Preview、Railway backend CORS/env、CI quality gate。
- 生产灰度按 viewer → operator → publisher 开放，production migration 独立核验，feature flag 默认关闭后逐步打开。
- 记录 test/prod 环境差异、project ref、部署 commit、变量变更、数据库前置条件、smoke test 和恢复路径。
- 汇总并更新根 README、docs/ARCHITECTURE、docs/schema归属地图、shared/backend/database/preset-platform specs。
- 父任务归档前确认每个实现子任务都已根据其 spec 影响补充相应文档。

## Acceptance Criteria

- [ ] 全链路 test smoke 覆盖登录、环境指纹、私有会话、模型、预设管理、抽屉、素材脱敏、SSE、发布/回滚。
- [ ] Vercel Preview 只连 test/preview backend，不能连接 production。
- [ ] Railway development/production/PR backend `PRESET_PLATFORM_URL`/CORS 口径已验证。
- [ ] CI 包含 shared/backend/preset-platform 的 typecheck/test/build 必要门禁。
- [ ] 生产灰度有停止条件、flag-off、revoke、rollback 或 forward-fix 说明。
- [ ] README/ARCHITECTURE/schema 归属/spec/module facts 已同步，且父任务记录剩余风险。

## Notes

- 该任务在所有功能子任务完成后启动。
- 不替代各子任务内的 spec 更新；它负责最终一致性检查。
