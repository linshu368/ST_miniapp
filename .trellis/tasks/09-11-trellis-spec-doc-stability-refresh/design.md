# 总体设计

## 边界与真相层级

采用“运行实现/部署配置与迁移工作流 → 已合入 commit 的明确决策 → `docs/ARCHITECTURE.md` → package spec/module spec → README/实施方案”的证据顺序。出现冲突时记录来源，不把推断写成事实；涉及生产实况且仓库无法证明时标记为待人工确认。

## 分层交付

1. **事实基线**：只盘点，不顺手改文档，输出按 P0/P1/P2 排序的漂移矩阵。
2. **Spec 与模块知识**：优先修会直接指导代码/迁移的规则；module knowledge 通过 `module-updates.json` 受控同步。
3. **根文档与流程**：用已稳定的 spec 反向收口 README、ARCHITECTURE、实施方案及 agent/workflow 规则。

## 规则落点

- 长期编码约束：各 package spec；通用措辞由 process 规范兜底。
- 实施与检查动作：`.trellis/agents/*`、`.cursor/skills/trellis-check/SKILL.md` 和 `.trellis/workflow.md`。
- 项目当前事实：`docs/ARCHITECTURE.md`；README 只保留入口级摘要。
- 功能状态与依赖：module specs，不在 workflow 中复制。

## 可靠性与恢复

- 本任务无运行时调用、写库、并发、事务、限流或容量风险；主要故障模型是错误事实扩散、部分同步、失效链接和过度门禁。
- 每阶段独立 review/commit，停止条件为发现生产事实无法由仓库证明或规则改变会影响现有行为；此时记录问题并询问，不擅自裁决。
- 回滚以子任务独立提交为单位；不修改历史 migration，文档错误优先 forward-fix。

## 最小充分方案

不新增第二套文档框架、生成器或测试框架，不借文档同步重构产品代码。只修改现有权威入口和确有漂移的 spec/module 文件。
