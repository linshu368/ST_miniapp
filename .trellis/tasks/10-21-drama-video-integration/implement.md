# 执行计划：短剧视频接入 miniapp（父任务整体顺序）

父任务本身不直接写代码；这里记录三个子任务之间的执行顺序、各自的 `task.py start` 时机，以及父任务自己要做的整合验证。

## 顺序

1. **启动并执行 `10-21-drama-archive-access`**：这是唯一的前置阻塞项。其余两个子任务在它验收通过前，实现工作不得开始（设计/mock 阶段的前期准备除外，例如子任务 3 的 mock UI 搭建可以提前并行）。
2. **启动并执行 `10-21-drama-api-contract-backend`**：子任务 1 验收通过后开始。
3. **启动并执行 `10-21-drama-frontend-ui`**：子任务 2 的接口在 test 环境真实联调通过后，把前端从 mock 切到真实接口；页面结构/占位态 UI 可以和子任务 2 并行提前搭（用 mock 数据），不必等到子任务 2 完全结束才动手写页面代码，只是"接真实接口"这一步必须等。
4. **父任务整合review**：三个子任务都验收通过后，在测试 miniapp 上实际走一遍完整用户路径（短剧 tab → 列表 → 详情 → 播放），核对父任务 `prd.md` 的 6 条 MVP 验收标准全部满足。

## 各子任务的 Trellis 生命周期

- 每个子任务独立走自己的 Phase 1（规划已在本次创建时完成，待人工审阅）→ `task.py start` → 实施 → 验收 → `task.py archive`。
- 不要在子任务 1 未归档/未验收前就对子任务 2 执行 `task.py start`——即使 Trellis 工具本身不会阻止这样做，这违反了本父任务记录的依赖顺序。
- 父任务自己是否需要单独 `task.py start`：父任务没有直接实现工作，只有最后的整合review。建议在三个子任务都验收通过、准备做整合review时才对父任务 `start`，完成整合review记录后再 `archive` 整个任务树。

## 验证层级

| 层级       | 验证方式                                                                  | 对应文档                                        |
| ---------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| 子任务 1   | SQL 权限查询、PostgREST curl、一次性脚本                                  | `10-21-drama-archive-access/implement.md`       |
| 子任务 2   | `pnpm --filter @miniapp/backend typecheck/test` + test 环境 curl 真实联调 | `10-21-drama-api-contract-backend/implement.md` |
| 子任务 3   | `pnpm --filter @miniapp/frontend typecheck/lint/build` + 移动端人工验证   | `10-21-drama-frontend-ui/implement.md`          |
| 父任务整合 | 测试 miniapp 完整用户路径人工走查，逐条核对 §6 验收标准                   | 本文件                                          |

## 风险控制

- 三个子任务都是新增代码/配置，不修改任何现有业务逻辑（除了 `BottomNav` 的增量扩展），整体回滚风险低，详见各自 `design.md` 的回滚章节。
- 最大的风险点集中在子任务 1 的 PostgREST `db_schemas` 暴露列表变更——这是对 test 项目共享基础设施（`authenticator` 角色的全局 GUC）的改动，必须严格按该子任务 `implement.md` 的"记录现状 → 断言 → 追加 → 验证"四步执行，出问题立即回滚，不要带着不确定状态推进到子任务 2。
