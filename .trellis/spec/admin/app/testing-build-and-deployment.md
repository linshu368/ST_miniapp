# Admin 测试、构建与部署规范

## 测试

- 纯转换、导航、差异、schema 和 API 参数使用 Vitest；现有测试与源文件邻近。
- 默认不自动新建测试文件。用户明确要求、审核后的验收标准确认需要，或 bug/环境隔离/配置兼容风险经确认必须回归锁定时再补测试；无论是否新建测试，现有相关测试与人工场景仍需执行。
- 高风险 mutation 至少验证重复提交保护、错误保留、成功刷新和权限失败。组件测试基础设施缺失时，必须记录人工场景和后续缺口，不得声称已自动覆盖。
- shared 契约变化还需运行 shared test/typecheck 和所有消费者 typecheck。

## 命令门禁

```bash
pnpm --filter @miniapp/admin typecheck
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/admin build
```

禁止通过跳过测试、关闭 strict 或忽略构建错误交付。宽范围 UI/依赖/环境改动必须执行 build。

## 环境变量与构建

- 变量清单以 `.env.example` 和读取点为准；新增/重命名同步包 README 与根 README。
- 不提交 `.env`；构建产物不得含 service-role、数据库 URI 或 admin token。
- Vite 构建时注入变量，运行期修改部署变量后需要重新部署。

## Vercel 部署

- 核对 Vercel 项目 Root Directory 后选择包内 `vercel.json` 或根 `vercel.admin.json`，不得假设两份配置会同时生效。
- 部署前确认 SPA rewrite、build/output、Node 版本和环境变量作用域；Preview 不得默认指向生产写接口。
- 发布后 smoke test：加载、登录/登出、环境标识、只读列表、一次受控测试写操作及错误页。回滚使用上一成功部署；数据库变更按 database spec 单独回滚。
