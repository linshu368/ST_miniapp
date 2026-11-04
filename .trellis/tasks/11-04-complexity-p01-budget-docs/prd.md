# 降复杂度 P0+P1：复杂度预算与 AI 文档减噪

父任务：`11-04-complexity-reduction`（方案与基线见父任务 prd.md）。

## Goal

用工具而不是文字约束复杂度增长，并减少 AI 搜索/阅读时命中的过时文字。只改脚本、CI、文档和 Trellis 配置，不改任何运行时代码。

## Requirements

1. **复杂度预算**：`scripts/complexity-budget.mjs`
   - 统计 `packages/*/src` 运行时代码（排除测试、`.d.ts`、`packages/ui-tests`）的文件行数和函数行数，上限 500 / 120 行。
   - `check`：基线外的新超标阻断；基线内增长只警告。接入 CI Quality Gate（`pnpm lint:complexity`）。
   - `update`：只收紧基线；`--allow-new` 例外放行，需在 PR 说明。
   - `report`：最长函数、超标数量、近 60 天"改动次数 × 行数"热点，用于定期复盘（`pnpm complexity:report`）。
   - 函数 key 用稳定名字：声明名 → 所赋变量名 → 调用方 + 首个字符串参数（如 `app.post('/api/x')`），尽量避免位置编号。
2. **Trellis 14 天归档**：`.trellis/scripts/archive_stale.py`
   - 按任务目录最后一次 Git 提交判断，默认 14 天；有活跃子任务的父任务跳过；未提交的任务目录不处理。
   - 先走 `task.py archive`；仅 module knowledge 门禁失败（payload 过期或缺失）时按同样方式归档，并把原因写进 task.json notes，不改 spec。
   - 默认只列出，`--apply` 才执行；不自动提交。
3. **`.ignore`**：`.trellis/tasks/archive/` 不进入 ripgrep 默认搜索（Claude Code / Codex 都基于 ripgrep）；查历史用 `rg -u`。
4. **README 只保留入门**：删除约 40 段发布状态/发布顺序说明（逐段核对过 spec/docs 已覆盖对应规则；Admin Vercel Preview 映射等长期说明保留），补充新文档入口。
5. **AGENTS.md**：补充复杂度预算与 14 天归档两条规则。
6. 不新增 `CLAUDE.md`：已观察到本机 Claude Code 会加载仓库 `AGENTS.md`，再加 `@AGENTS.md` 会重复注入。

## Acceptance Criteria

- [ ] `pnpm lint:complexity` 在当前 dev 上通过（基线 51 文件 / 132 函数）；人为新增一个 130 行函数时失败。
- [ ] `python3 .trellis/scripts/archive_stale.py` 列出 0 个（当前最早任务 9 天）；`--days 8 --apply` 在临时演练中能归档门禁失败的任务且不改 spec（已演练并还原）。
- [ ] `rg first-token-fallback` 不再命中 `.trellis/tasks/archive/`。
- [ ] README 无"本地候选 / 尚未发布 / 发布顺序"类段落。
- [ ] `pnpm format:check` 对改动文件通过；CI Quality Gate 通过。

## Android/iOS 性能 P95 门禁

不适用：本任务只改脚本、CI、文档与 Trellis 配置，不改变任何运行时代码、页面或接口。
