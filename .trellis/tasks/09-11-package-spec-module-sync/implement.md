# 实施计划

1. 读取事实基线和漂移矩阵，冻结本子任务文件清单。
2. 修复 P0：database migration 规则、shared 已删除导出、所有失效引用。
3. 修复 P1/P2：生成计费、统一发奖、模型 catalog、前端编排、CI/部署等包级事实。
4. 准备 `module-updates.json`，更新声明模块并重建 modules index。
5. 运行关键词、链接、上下文和格式检查，展示最终 diff 供人工审核。

## 验证

```bash
python ./.trellis/scripts/get_context.py --mode packages
python ./.trellis/scripts/module_knowledge.py check 09-11-package-spec-module-sync
python ./.trellis/scripts/module_knowledge.py rebuild-index
python ./.trellis/scripts/task.py validate 09-11-package-spec-module-sync
pnpm exec prettier --check .trellis/spec
pnpm lint:legacy
pnpm lint:migrations
```

本子任务默认不创建测试文件；只在确认 Trellis/module 脚本行为改变且需要回归锁定时另行批准测试。
