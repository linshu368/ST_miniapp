# Preset Platform Backend 基座实施计划

## 顺序

1. 读取 backend 路由、鉴权、配置、安全 spec，以及父任务设计。
2. 搜索 Admin Supabase session 校验、CORS/config、request logger、现有 internal route 和 repository 模式。
3. 新增 backend config/env：`PRESET_PLATFORM_URL`、feature flag、限额基础配置和环境 fingerprint。
4. 实现 Preset Platform auth/authorization，复用 Admin 账号/角色表作为身份来源，平台授权独立落 `preset_platform`。
5. 建立 route/feature/repository 骨架，所有 route 使用 shared 契约解析并保留 `@frontend-ready`。
6. 补 401/403/404/409/429/422/5xx 映射、Pino allowlist 和审计基础。
7. 补测试并更新 backend spec/module facts。

## 验证

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
```
