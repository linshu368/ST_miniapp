# 实施计划

1. 读取 `449cdda..HEAD` 的提交摘要和关键 diff，建立决策时间线。
2. 用当前代码/配置核验每项决策是否仍成立，记录反例和后续修复 commit。
3. 审计根文档、package specs、module specs 和 workflow/agents，生成 P0/P1/P2 漂移矩阵。
4. 扫描退场关键词、失效路径和旧迁移规则，补充漏项。
5. 展示研究文档供人工确认；本任务不进入文档修复。

## 验证

```bash
git --no-pager log --oneline 449cdda..HEAD
python ./.trellis/scripts/get_context.py --mode packages
python ./.trellis/scripts/task.py validate 09-11-system-fact-baseline-audit
```

另运行关键词扫描：`st-bridge`、`llm_model_tiers`、`ST_`、`LLM_PROXY_TOKEN_SECRET`、旧迁移编号、`grant_bonus_credits`、`applyLlmCharge`、`botlink`。不创建测试文件。
