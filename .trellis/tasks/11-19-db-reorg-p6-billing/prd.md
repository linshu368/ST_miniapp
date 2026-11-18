# 数据库重组阶段 6：观测外迁 + 计费统一

父任务：`.trellis/tasks/11-17-db-reorg`。规则见 `docs/db/CONTRACT.md`，落位见 `docs/db/registry.yaml`（phase 6 条目，以及阶段 2 因缠着计费函数顺延过来的观测外迁）。

## 目标

1. **观测外迁（6a，不碰钱）**：上游调用的测速列、三张供应商明细表、畅聊多路调用的成本列、媒体生成的耗时列迁到 `ops`（O，按保留期清理）；已无读者的测速列直接删除。业务表只留交付状态与计费依据（S）。
2. **计费统一（6b）**：文本、语音、聊天配图、图片广场、视频广场的报价与扣费字段统一进 `billing.usage_charges`（一次可计费动作一行，生命周期 quoted → reserved → charged / waived / refunded），业务表只存 `charge_id`。去掉"只留最近 100 条 + 去重表"的旧结构，消费记录从一张表读。

## 约束

- 每个子步可独立上线：扩展 → 后端发布 → pg_stat_statements（按角色，两次采样）确认旧读写停涨 → 收缩。纯数据库内的子步可以一个迁移完成，但锁内只做增量与 DDL。
- 碰钱已授权直接做，但 6b 每步前后必须按日对账一致：流水（`wallet_ledger`）金额与笔数、业务表实扣、免费额度决定、退款。
- 视频广场是他人在迭代的模块：动 `media_plaza` 之前先看最近提交、PR 与 `.trellis/tasks/11-18-video-spending-records`，放在最后做。
- 聊天配图（4b）与广场租约列（4c）等用户决定后再动。
- 不读业务行；生产只看结构与聚合。

## 验收

- 计费门禁、交付仲裁、结算与回捞、消费记录、看板日汇总、畅聊模型评估的结果前后一致；
- 6b 完成后 `billing.llm_usage_charges`、`billing.llm_usage_charge_dedup` 删除，`chat_history` 不再有计费列；
- registry 的 phase 6 条目全部落位，契约 lint 不再对这些表报 moving。
