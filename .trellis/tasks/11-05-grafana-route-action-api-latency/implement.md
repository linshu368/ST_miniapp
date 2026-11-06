# 执行计划

1. 审核 PRD、路由层级、按钮范围和 SSE 2 秒口径；确认任务保持 `planning`，审核前不写产品代码。
2. 扩展现有 action Grafana mirror：全部九个既有关键动作、安全 route template、canonical entry；保持原 settle、timer、Sentry 和业务回调不变。
3. 新增二级页面与三级页面 dashboard JSON，复用 page.navigation/launch/terminal/stall，Android/iOS 分组和 2 秒阈值。
4. 新增按钮 dashboard JSON，按 entry/route/action/platform 展示 P95、≤2秒、N 与终态；按 release 隔离旧 route 口径。
5. 新增非流式 API dashboard JSON：客户端总等待与服务端 route 耗时分别展示，排除 SSE/NDJSON，保留失败与样本量。
6. 新增 SSE/流式 dashboard JSON：send/regenerate 首 token 与完整流分离；creator polish 独立注明 NDJSON；只给响应阶段 2 秒线。
7. 更新 `docs/grafana/README.md`/`engineering-performance.md`，记录层级表、导入方式、查询边界、性能隔离、发布后验收和回滚。
8. 验证：
   - `pnpm --filter @miniapp/frontend test -- action-tracker grafana route-template`
   - `pnpm --filter @miniapp/frontend typecheck`
   - `pnpm --filter @miniapp/frontend test`
   - `pnpm --filter @miniapp/frontend lint`
   - `pnpm --filter @miniapp/frontend build`
   - `pnpm lint:complexity`
   - PowerShell `ConvertFrom-Json` 解析五份 JSON，并检查 UID/panel ID/变量/threshold。
   - 可用时执行本地固定 Faro→Alloy→Loki 虚构查询；不可用或 Cloud 只读则记录未验证风险。
   - `git diff --check`
9. 发布后按 release 连续两个完整 24h 窗口验证 Android/iOS；每组 N<100 延长，不把 no data 当 0。对比遥测健康和同口径业务 P95，>5% 回退即回滚 action 投影。

## 审核门

- 本计划不自动写入 Grafana Cloud；生产导入仍按现有权限和发布流程执行。
- 默认只修改既有测试文件，不新建测试框架。若实现发现现有测试无法覆盖 dashboard schema，再回到规划说明新增测试文件必要性。
- 当前工作树位于 `feat_alert_warning`，实施前需由工程师确认是否切到基于最新 `origin/dev` 的独立 feature branch，避免混入无关提交。
