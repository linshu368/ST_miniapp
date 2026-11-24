# 任务分解

- [x] shared `spec.ts`：每种样式 `renders(item, value)`
- [x] shared `validate.ts`：`items`（逐项 fresh/empty/kind_mismatch/carried）与 `stage`
- [x] shared `memory-bar/apply.ts`：失败结果带 `stage` 与 `problems` 码
- [x] 已有测试文件补用例（见 implement.md）
- [x] exporter `count` 值参数；`engineering-observability.ts` 三个 observe 函数 + 用例
- [x] 状态栏 `update.ts` 接入（attempt / update / items / store / pino 字段 / error_code）
- [x] 记忆栏 `update.ts` 接入（attempt / update / store / pino 字段 / error_code）
- [x] 本地验证命令全部通过
- [x] 基线：生产快照显示检查（只读）+ Railway 项级沿用率，写入 design.md §7
- [x] `docs/grafana/st-panel-quality.json` 与 README 登记
- [ ] PR、合 main、确认部署、导入看板、24 小时核对
