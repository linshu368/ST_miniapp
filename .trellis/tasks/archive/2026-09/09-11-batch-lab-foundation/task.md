# Task Breakdown

## 依赖

- 父任务规划人工评审

## Tasks

| ID  | Status | Task                                   | Files / Scope               | Depends On | Verification                       |
| --- | ------ | -------------------------------------- | --------------------------- | ---------- | ---------------------------------- |
| T0  | Done   | 人工评审并确认依赖/环境/只读门禁       | task artifacts + target env | -          | 2026-09-11 明确 start 与收口授权   |
| T1  | Done   | 冻结 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | schema tests + consumers typecheck |
| T2  | Done   | 实现最小 Backend 配置与 context 边界   | backend route/config        | T1         | route tests + fail-closed          |
| T3  | Done   | 实现工程框架、Vercel与CI部署核心能力   | owned application files     | T2         | typecheck/test/build               |
| T4  | Done   | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | 取消/超时/协议/环境测试            |
| T5  | Done   | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | module knowledge check             |

## 完成定义

- [ ] V1不包含登录、session或角色代码，API client不发送Bearer token
- [ ] 环境context失败或配置缺失时fail closed，不猜测来源环境
- [ ] 浏览器不含 service-role、数据库连接或供应商密钥
- [ ] 新包可 typecheck/test/build，既有四应用不发生跨应用 import
- [ ] Vercel静态部署、SPA rewrite、Preview API base/CORS和CI test/build通过
- [ ] 验证命令、失败路径、发布/回滚和 Spec/module payload完整。
- [ ] 本任务独立归档后，父任务仍不完成；必须等待 integration-spec 全量收口。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0等待人工评审。
- 2026-09-11：人工批准启动；完成 Shared 基础契约、Batch Lab SPA/client/context gate、Backend context/CORS 配置、Vercel/env/CI 基线。
- 2026-09-11：Shared 66 tests、Batch Lab 5 tests、Backend 路由 3 tests、Batch Lab build 与 `pnpm -r typecheck` 通过；Vite 报 500 kB chunk 警告。
- 2026-09-11：`pnpm lint:imports` 因仓库脚本在当前 ESLint 下将 `--rule '{}'` 解析为非法参数而失败，未通过跳过规则伪报成功；需仓库级 owner 修复脚本后重跑。
- 2026-09-11：`module-updates.json` 已准备并通过 `module_knowledge.py check`；未执行 apply/archive/commit/push，等待人工确认。
