# 当前状态初步审计

## 证据范围

- 近期提交：`449cdda`、`bae09ea`、`e6df087`、`d9d85d8`、`815a7f4`、`dbe55ce`、`9b77eca`、`7a91a24`、`aab13d3`、`88e8a50`、`82d254d`、`daaa9f3`、`009a4b0`。
- 当前入口：`README.md`、`docs/ARCHITECTURE.md`、`docs/重构实施方案.md`、`.trellis/workflow.md`、各 package/database/shared spec 与 modules index。

## 已确认的高优先级漂移

1. `.trellis/spec/database/supabase/migrations-and-rollbacks.md` 仍描述旧编号迁移；现行规则是日期命名、`supabase_migrations.repo_migrations` 账本和 `psql` 单文件执行。
2. `README.md` 仍把 `ST_*` 与 `LLM_PROXY_TOKEN_SECRET` 列为现行 backend 配置；应用链路已退场，仅可能是部署控制台遗留。
3. shared spec 仍描述已删除的 `st-bridge` 导出；legacy guard 已禁止恢复退场包/标识。
4. package/module specs 尚未完整反映模型 catalog 单轨、`applyLlmCharge`、`billing.grant_bonus_credits`、P3 前端编排拆分及 botlink/UAT 清理。
5. workflow/agent 仍可能把“新增函数”机械等同于“新增单测”，与本轮目标规则冲突。

## 规则裁决建议

- 注释：复杂方法、业务编排、非显然约束、关键状态转换与边界处理尽量解释“为什么”；简单自解释方法无需；专项结构化注释不豁免。
- 测试：不自动创建 test 文件，创建前需由用户、规划/验收标准或风险评估明确确认；验证本身仍是强制门禁，应运行现有相关测试及其他适用检查。
