# Preset Platform 集成灰度与文档实施计划

## 顺序

1. 汇总所有子任务实现、验证记录、spec 更新和剩余风险。
2. 跑全链路 test smoke：登录、环境、私有会话、模型、预设管理/抽屉、素材脱敏、SSE、发布/回滚。
3. 验证 Vercel Preview 只连 test/preview backend；Railway backend CORS/env 与 PR backend URL 对齐。
4. 验证 CI quality gate 覆盖 shared/backend/preset-platform 的 typecheck/test/build。
5. 生产灰度前独立核验 migration shape、feature flag、viewer/operator/publisher 权限和恢复路径。
6. 更新根 README、docs/ARCHITECTURE、docs/schema归属地图、shared/backend/database/preset-platform specs。
7. 准备父任务最终评审包和归档前检查。

## 验证

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/preset-platform typecheck
pnpm --filter @miniapp/preset-platform test
pnpm --filter @miniapp/preset-platform build
pnpm -r typecheck
pnpm lint:imports
pnpm format:check
```
