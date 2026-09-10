# Preset Platform 会话预设 Backend API 实施计划

## 顺序

1. 读取父任务设计、shared 契约、数据库 RPC 和 backend route/repository 规范。
2. 实现私有会话 API：列表、创建、详情、重命名、归档/删除、绑定模型/预设/角色。
3. 实现预设库和草稿 API：已发布预设查看/应用，私有草稿 CRUD、覆盖确认、另存。
4. 实现平台默认发布/回滚 API：immutable release、expected revision、审计、生产确认字段。
5. 补错误映射、Pino allowlist 和角色权限测试。
6. 更新 backend spec/module facts；如 DTO 调整，同步 shared spec。

## 验证

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
```
