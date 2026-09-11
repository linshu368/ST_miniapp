# 实施计划

1. 依据事实基线和已更新 spec 修正 README、ARCHITECTURE、重构实施方案。
2. 在 process/package specs 放置长期注释与测试创建原则，保留专项例外。
3. 更新 implement/check agents 和 Cursor inline check skill，删除机械“新函数必测”表述。
4. 更新 workflow Phase 2 实施/质量检查说明；只有每回合必须提示时才修改 workflow-state block。
5. 扫描规则冲突和退场事实，运行格式、上下文与适用的 Trellis regression。

## 验证

```bash
python ./.trellis/scripts/get_context.py --mode packages
python ./.trellis/scripts/task.py validate 09-11-docs-workflow-gate-sync
pnpm exec prettier --check README.md docs/ARCHITECTURE.md docs/重构实施方案.md .trellis/workflow.md .trellis/agents .cursor/skills/trellis-check/SKILL.md .trellis/spec/docs/process/index.md
pnpm lint:legacy
pnpm lint:migrations
```

若 workflow-state block 或其解析契约发生变化，再运行 Trellis 自带 regression；本规划不预先创建新测试文件。
