# 数据库重组阶段 5：experience.chat_history 瘦身

父任务：`.trellis/tasks/11-17-db-reorg`。规则见 `docs/db/CONTRACT.md`，落位见 `docs/db/registry.yaml`。

## 目标

1. `chat_history` 只留对话轮次本身（E）与阶段 6 再迁的计费列；发给模型的 prompt 快照（`history`，占表 95% 以上、每天新增约 0.5–1GB）迁到 `ops`，按保留期清理，主表空间实际释放。
2. 首字预览 `first_token_preview` 归交付状态表 `chat_generation_requests`。
3. `rich_reply_metadata.drive_mode` 转真列，与另外三个指令槽档位列并列。
4. 删掉已不写入的 `upstream_status` 与没人用的两个索引。
5. 展示投影（request_id、开场白）对全部存量轮次补齐，读路径不再现场解压 `history`。

## 约束

- 扩展 → 后端发布 → pg_stat_statements（按角色）确认旧读写停涨 → 收缩。
- 最大最热的表：DDL 只做目录级改动并设 `lock_timeout`；回填、搬数据、清空一律按批提交（迁移里用过程逐批 COMMIT），不长时间持锁。
- 不读业务行；生产只看结构与聚合。
- 不碰计费列（`deduction_rate`、`llm_intended_deduction`、`llm_billing_snapshot`、`llm_billing_settled_at`），留阶段 6。

## 验收

- `chat_history` 总大小从约 24GB 降到 1–2GB 量级（TOAST 由 autovacuum 截断释放），之后不再随 prompt 长度增长；
- 消息列表、上下文组装、重生成、分叉、交付恢复（首字预览）、富回复诊断行为不变；
- `ops` 里的 prompt 快照按保留期每天清理。
