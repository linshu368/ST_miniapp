# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                           | Files / Scope                               | Depends On | Verification                           |
| --- | ------ | ---------------------------------------------- | ------------------------------------------- | ---------- | -------------------------------------- |
| T1  | Done   | 固化事故根因、复用与可靠性证据                 | `research/incident-and-release-evidence.md` | -          | Supabase/Railway/仓库三方互证          |
| T2  | Done   | 对账 TEST/Production 索引与 migration checksum | 远端只读 catalog/账本                       | T1         | valid/ready/定义/checksum/EXPLAIN      |
| T3  | Done   | 观察 Railway 最终发布与发布后短窗口            | Railway 主服务、Supabase logs               | T2         | deployment SUCCESS、健康/错误/慢查询   |
| T4  | Done   | 完成任务验证记录，不重复实现已上线修复         | 本任务文档                                  | T3         | `task.py validate`、`git diff --check` |
| T5  | Done   | 复测 sync job 基线并核对扫描计划               | Railway/Supabase 只读证据                   | T4         | 12—18s 基线、两条 EXPLAIN              |
| T6  | Done   | 实现批量读取、有界并发、状态退避与无变化不写   | sync job / OpenRouter repository            | T5         | 代码审查与现有测试扩展                 |
| T7  | Done   | 完成本地消费者与失败路径验证                   | backend tests/typecheck/lint                | T6         | 924 tests、typecheck、定向静态检查     |
| T8  | Done   | 更新模块影响判定与交付记录                     | task / research                             | T7         | Trellis validate、diff check           |

## Execution Log

- 2026-10-27 14:56:16+08：Production 账本记录 `20261027_chat_charge_lookup_index.sql`。
- 2026-10-27 15:04+08：TEST/Production 均已存在目标索引；Production EXPLAIN 已使用 Index Scan，计划成本约 5.15。
- 2026-10-27 15:05+08：Railway 开始发布 main `88cd811`，等待最终状态和短窗口核验。
- 2026-10-27 15:07+08：主服务及四个任务服务发布 SUCCESS，`/health` 返回 200/5ms。
- 2026-10-27 15:10+08：索引后 263 次计费调用增量均值约 2.51ms、0.58 block read/次；无新的同类慢计划。最近完整 sync run 约 12—18 秒。
- 2026-10-27 15:11+08：Trellis context validation、`pnpm lint:migrations`、`git diff --check` 通过；当前分支仅新增本任务证据文档。
- 2026-10-27 15:20+08：用户授权继续深度优化 sync job；发布后轮次约 44—45 条、其中约 39 条 not-ready，单轮约 12—18 秒。
- 2026-10-27 15:25+08：Production 只读 EXPLAIN：待结算扫描成本约 260，OpenRouter 待补扫描成本约 85，均走 `created_at` 索引；拒绝无证据新增索引，进入应用层 N+1/退避优化。
- 2026-10-27 15:26+08：sync job 已实现最多 50 条批量读取、3 路记录并发、每轮 9 次 provider 预算、30s→240s 状态退避、无 finish 计费短路和无变化不写；定向 43 tests、全 backend 924 tests 与 typecheck 通过。
- 2026-10-27 15:27+08：根 `lint:imports` 因脚本向当前 ESLint 传入字符串 `--rule '{}'` 失败；不改仓库工具链，改用等价定向 ESLint（去掉无效空 rule）及 Prettier 检查，均通过。Backend 无独立 build 脚本。
- 2026-10-27 15:29+08：Trellis context validate 与 `git diff --check` 通过；模块影响判定为不改变模块事实。`module_knowledge baseline-check` 因仓库现有 `.trellis/spec/backend/app/modules/index.md` 漂移失败，该文件未被本任务修改，未擅自 rebuild 混入无关变更。
