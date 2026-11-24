# 实施计划

## 顺序

1. shared：`spec.ts` 加 `renders`；`validate.ts` 产出 `items` 与 `stage`；`memory-bar/apply.ts` 产出 `stage` 与 `problems`。
2. backend 遥测：exporter `count` 加值参数；`engineering-observability.ts` 加三个 observe 函数。
3. backend 接入：状态栏、记忆栏 `update.ts` 每次尝试与终态打点；写库失败记 `store`；pino 字段补充。
4. 基线：只读脚本（放 scratchpad，不提交）跑生产快照显示检查；Railway 日志汇总项级沿用率；结果写回 `design.md §7`。
5. 看板：`docs/grafana/st-panel-quality.json`，在 test 环境数据上先验证查询，发布后导入生产。
6. 发布：PR → Quality Gate → 合 main → 确认部署 → 24 小时后核对看板与 Railway 日志量级。

## 验证

### 命令

```bash
pnpm --filter @miniapp/shared test -- status-bar memory-bar
pnpm --filter @miniapp/backend test -- engineering-observability status-bar memory-bar
pnpm -r typecheck
pnpm lint:backend-logging
pnpm lint:complexity
python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-24-panel-quality-monitor
```

### 需要覆盖的用例（在已有测试文件里加用例，不新建测试文件）

- `status-bar-consistency.test.ts`：每种样式的 `example` 都 `renders` 为真（同源对账）；`line` 写成 `3/5`、`number` 写成 `26`、`line` 写成 `A、B` 判错位；`tags` 单个短词不判错位。
- `status-bar-parse.test.ts`（或 validate 相关用例）：缺项 → `carried`；写"暂无" → `empty`；旧格式 → `stage=format`；全对 → 全 `fresh`、`stage=ok`；每人一组整组沿用 → 该组各项 `carried`。
- `memory-bar.test.ts`：非 JSON → `stage=format`；记录超长 → `stage=content`、`problems` 含 `record_too_long`；通过 → `ok`。
- `engineering-observability.test.ts`：遥测关闭时三个函数不抛错；标签越界被收口为 `other/unknown`；`count` 的值参数生效。

### 失败路径

- 首发报错 → 兜底成功：两条 attempt（model / ok），一条 update（perfect 或 degraded，channel=fallback）。
- 两次都失败：两条 attempt，一条 update `failed`，项级全部 `carried`。
- 写库抛错：update `failed stage=store`，原错误照常抛出，手动刷新仍返回 500 / 自动更新仍记 `status_bar.update.failed`。
- 手动刷新撞上进行中的自动更新：只计一次。
- 遥测关闭（本地默认）：业务行为与改动前一致。

### 人工

- TEST/development 环境走一遍：聊 3 轮触发自动更新、手动更新一次，Cloud Metrics `environment="test"` 能查到三个指标，Railway 日志带新字段且 `primary.failed` 有 `error_code`。
- 生产发布后 24 小时：看板数字与 Railway `status_bar.update` / `memory_bar.update` 条数同量级。

## 本地验收系统

本任务不改前端页面，不新增 `packages/ui-tests` 场景。
