# Shared 契约规范

`@miniapp/shared` 是 frontend、backend、admin、cs-platform 唯一共享契约层。适用于 `packages/shared/src/**`；SQL migration 由 database spec 管理。

## 专题规范

- [架构与出口](./architecture-and-exports.md)
- [API 契约目录与规则](./api-contracts.md)
- [Schema、工具与 fixture](./schemas-utilities-and-fixtures.md)
- [测试与变更管理](./testing-and-change-management.md)

## Pre-Development Checklist

1. 搜索已有 API DTO、schema、常量、helper 和所有 producer/consumer。
2. 判断类型是否真正跨应用；单应用内部类型不得放 shared。
3. 明确 runtime validation、browser-safe、兼容、发布顺序和旧调用方。
4. 复杂契约在 design 中列出复用选择、失败/兼容模型和最小公开 API。

## Required Rules

- 公开 HTTP/SSE DTO 必须先定义于 `src/api/*`；应用包不得私定同一契约。
- 禁止暴露数据库 row、repository、网络请求、应用组件/状态、鉴权和部署实现。
- shared 不得导入任何应用包；根出口不得导出 Node/server-only 依赖。
- 已发布字段/联合值不得无迁移删除、重命名、收窄或改变语义；优先兼容扩展。
- runtime helper 必须确定、无隐藏 I/O/环境读取/全局可变状态。

## Quality Check

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm -r typecheck
```
