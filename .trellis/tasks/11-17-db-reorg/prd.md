# 数据库契约与彻底拆分重组

## Goal

项目长期按功能插入式地加表、加列，业务字段、计费字段、测速与监控字段、任务租约字段混在同一批宽表里。90% 以上的代码由 AI 编写，缺少"字段该放哪"的规则，复杂度持续上升。

本任务要做两件事：
1. 建立一份写给 AI 读的数据库契约：业务域 × 数据性质，加上 registry 和 CI 警告，让新增改动自动落到正确的位置。
2. 趁用户量还小（一百多人），把存量结构**彻底**拆分重组到契约描述的目标结构。

## 已定决策（项目所有者，2026-11-17）

- 新建 `ops` schema，收拢监控、测速、告警、上游调用明细。能降复杂度的新 schema 一律准许，本任务另建 `cs_feed`。
- 分阶段执行，但目标是彻底拆分，不只管新增。
- 契约的 CI 检查为中等强度：PR 上给警告，不阻断合并。
- 早期阶段走最简路径：直接替换旧结构，不做双写、影子期、灰度。**资金数据（billing）例外**，按正常标准谨慎处理。

## Requirements

1. 新增 `docs/db/CONTRACT.md`（规则）与 `docs/db/registry.yaml`（全量表登记：现状 + 目标 + 阶段），作为数据库落位的唯一权威。
2. 让 Claude Code 和 Codex 都自动读到落位规则：
   - `AGENTS.md` 放落位卡；
   - 新增 `CLAUDE.md` 引用 `AGENTS.md`；
   - 旧 spec 与 ARCHITECTURE 里同类描述改为指向契约。
3. `Quality Gate` 加契约 lint：对比 migration 与 registry，只给 PR 警告。
4. 按 `design.md` 的阶段 1–6 完成迁移。每个阶段完成后，registry 回写为最终状态。
5. 外部读者不受影响：
   - 客服仓库在阶段 1 切到 `cs_feed` 视图；
   - Grafana 面板在 `analytics_grafana` 并入 `miniapp_analytics` 时同步改 SQL；
   - 指标读者角色同步改授权。

## Acceptance Criteria

- [ ] 生产库中本仓库拥有的每张表、每个计划表都在 registry 中，且性质与位置一致（阶段全部完成后无 `moving`）。
- [ ] `ops` 以外没有 O 性质的列。`billing` 以外没有价格、折扣、扣费快照列（只剩 `*_charge_id` / `*_ledger_id` 引用）。`*_jobs` 以外没有租约、重试列。
- [ ] 不再有按供应商命名的表、`*_before_*` 包装函数、两份 `total_round`。
- [ ] 外部角色（客服、Grafana、指标读者）只对 `cs_feed`、`miniapp_analytics` 有 SELECT。
- [ ] 每个阶段上线后，用户可见行为、扣费结果、看板数字与上线前一致（逐阶段核对，见 design.md）。
- [ ] 契约 lint 在 CI 中运行，能对 CONTRACT §7 列出的每类违规给出警告。

## Android/iOS 性能 P95 门禁

- 本父任务只承载契约与总体规划，不直接改运行时行为，填 `not_applicable`。
- 阶段 1–6 各建子任务，各自声明受影响接口与 P95。重点是阶段 5（`chat_history` 瘦身）和阶段 6（计费统一），会影响对话发送与消息列表接口。

## Notes

- 日志接入：父任务是纯文档，填 `not_applicable`。各阶段子任务各自评估：迁表涉及的 repository 与 RPC 失败路径沿用现有 pino 规范。
