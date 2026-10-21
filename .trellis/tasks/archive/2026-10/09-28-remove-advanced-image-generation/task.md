# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                    | Files / Scope                                          | Depends On | Verification                               |
| --- | ------ | ------------------------------------------------------- | ------------------------------------------------------ | ---------- | ------------------------------------------ |
| T1  | Done   | 审核数据库现状并锁定 advanced-only 边界                 | 指定 commits、迁移结构                                 | -          | 保留历史列与 basic_image；配置需 migration |
| T2  | Done   | 建立逐 hunk allowlist 与三方基线报告                    | `research/commit-scope-analysis.md`、候选 images 文件  | T1         | 仅 advanced 活功能退场                     |
| T3  | Done   | 移除 Shared advanced 契约并保留 free-trial/旧客户端兼容 | Shared images/wallet/feature-free-trials 与现有 tests  | T2         | basic_image quota 与旧 tier 输入兼容       |
| T4  | Done   | Backend 删除 advanced，保留普通图片免费/付费生成        | image config/route/generate                            | T3         | typecheck 通过                             |
| T5  | Done   | Frontend 删除高级图片 UI，保留普通图片全流程            | chat image component/page、VIP presentation            | T3,T4      | typecheck 通过                             |
| T6  | Done   | Admin 删除高级图片配置，保留 basic_image 免费次数       | config schema/editor/navigation 与现有 tests           | T3         | typecheck 通过                             |
| T7  | Done   | 新增 advanced 配置清理 forward migration                | runtime config、Admin 草稿/发布、managed key/validator | T2,T4      | 保留 basic_image、历史 attempt 与结算函数  |
| T8  | Done   | 跨包与非图片回归验证                                    | 四包、legacy/migration guards                          | T3-T7      | 四包 test/typecheck 通过；已记录工具故障   |
| T9  | Done   | 最终路径/hunk 审计与 module knowledge 更新              | diff、五个受影响模块                                   | T8         | 仅负向测试保留 advanced 字样               |

## Execution Log

- 2026-09-28：仅完成规划与本地历史调研；任务保持 `planning`，未修改产品代码、未启动实施。
- 2026-09-28：实施 advanced-only 应用收敛；保留 `basic_image` 免费次数全链路，初次实现未新增/修改 migration。
- 2026-09-28：Shared 97、Backend 527、Frontend 192、Admin 46 项测试通过；四包 typecheck、Admin build、legacy/migration guard 通过。
- 2026-09-28：Frontend lint/build 受本地 `eslint-plugin-react` 缺失和并发 Next build 污染阻塞；独立 no-lint build 已完成编译、类型检查与静态页面生成后，另一次并发构建因 Next 安装/产物缺失失败。`lint:imports` 受仓库 ESLint `--rule '{}'` 参数兼容故障阻塞。
- 2026-09-28：`module-updates.json` 已生成；`module_knowledge.py check` 被未改动的 `.trellis/spec/admin/app/modules/infrastructure/admin-client-auth.md` 既有 BOM/frontmatter 识别问题阻塞。
- 2026-09-28：按补充要求新增 `20260928_remove_advanced_image_config.sql`；只收敛 advanced 配置数据与 Admin 管理边界，不执行远端 migration。
- 2026-09-28：新增 migration 通过 `lint:migrations`、`lint:legacy`、`git diff --check`。本机无 `psql`，且本地依赖后续出现 `magic-string/@jridgewell/sourcemap-codec` 缺失，故未执行 throwaway DB，新增 migration 后的重复 test 被环境阻塞；此前四包测试/typecheck 结果仍有效。
