# 收口根文档与 Trellis 工作流门禁

## 目标

在 package spec 稳定后收口根文档和 Trellis 执行门禁，使项目事实、注释规则、测试文件创建策略与验证要求一致。

## 需求

- 修正 README、ARCHITECTURE、重构实施方案中的过时功能、配置、包拓扑、迁移、测试和待办描述。
- 在 workflow、implement/check agents、Cursor inline check skill 与 process/spec 中统一注释规则。
- 默认不自动创建 test 文件；创建必须由用户、审核后的规划/验收标准或明确风险评估确认。
- 保持质量检查 required：运行现有相关测试、typecheck、lint、build、静态检查或人工回归；不允许用“不建测试”解释为“不验证”。
- 移除“每个新函数必有单测”等机械门禁，保留 bug 回归、安全/计费/并发/契约/迁移等高风险测试建议，但仍需在规划中确认。

## 验收标准

- [ ] README 不再把 ST/旧代理 secret 写成现行配置，包拓扑与当前 workspace 一致。
- [ ] ARCHITECTURE 与已审核 spec/module facts 一致，实施方案中的已完成/待办状态不漂移。
- [ ] agent、workflow、inline skill 和 process 对注释/测试使用同一语义，无“新函数必建测试”残留。
- [ ] 专项强制注释和验证未被一般规则覆盖或豁免。
- [ ] workflow-state block 若修改，其 required breadcrumb 回归和解析测试通过；若仅改 walkthrough，也完成同步核对。
- [ ] Markdown 格式、失效链接、关键词漂移与 task validate 通过。

## 约束

- 依赖：事实基线和 package spec/module 同步均已审核完成。
- 不改产品代码；若工作流脚本行为需改变，先说明并重新确认测试必要性。
