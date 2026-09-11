# 总体实施计划

1. 完成并审核 `system-fact-baseline-audit`，冻结本轮证据范围和漂移矩阵。
2. 以该矩阵为输入完成 `package-spec-module-sync`，优先 P0，再处理 P1/P2；校验 module knowledge。
3. 在 package 规则稳定后完成 `docs-workflow-gate-sync`，统一入口文档、注释边界与测试创建策略。
4. 父任务执行全局集成检查：失效路径、退场标识、迁移规则、配置变量、规则措辞和 Markdown 格式。
5. 按子任务分别向人工展示最终 diff、验证结果与拟提交文件；未经确认不 stage/commit，不 push。

## 总体验证

```bash
python ./.trellis/scripts/get_context.py --mode packages
python ./.trellis/scripts/task.py validate 09-11-system-fact-baseline-audit
python ./.trellis/scripts/task.py validate 09-11-package-spec-module-sync
python ./.trellis/scripts/task.py validate 09-11-docs-workflow-gate-sync
pnpm exec prettier --check README.md docs/ARCHITECTURE.md docs/重构实施方案.md .trellis/workflow.md .trellis/spec .trellis/agents
pnpm lint:legacy
pnpm lint:migrations
```

验证原则：默认不新建测试文件。本任务改动纯文档/流程，使用结构校验、现有 Trellis 回归（若流程解析块变化）、静态扫描和人工可读性检查；只有确认脚本行为需要锁定时才补测试。
