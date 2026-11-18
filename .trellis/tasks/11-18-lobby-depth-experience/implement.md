# 执行计划

1. 新增 `miniapp_features.character_deep_experience_stats` migration，登记表、索引、RLS/grant 和回滚说明。
2. 在大厅统计模块新增深度 session 聚合与覆盖式摘要写入，接入现有每日刷新任务的同一专用连接和短事务。
3. 扩展 `get_character_socials` 及其后续迁移定义，把摘要加到已有 `like_count`，保持用户 `liked`、收藏和评论语义。
4. 更新 Backend/Shared 相关测试与迁移验收，覆盖边界、重生成去重、失败保留旧快照和读路径不扫聊天历史。
5. 运行 shared/backend typecheck、相关测试、数据库契约检查和日志门禁。审查最终 diff，只包含本功能。

## 可执行验证

- `pnpm test:lobby-deep-experience`
- `pnpm --filter @miniapp/shared test`
- `pnpm --filter @miniapp/backend typecheck`
- `pnpm --filter @miniapp/backend test -- src/features/lobby src/routes/character-social`
- `pnpm lint:backend-logging`
- `python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-18-lobby-depth-experience`
- 使用本地 PostgreSQL/迁移 fixture 检查 20/21 轮、30 分钟边界、revision 去重、重复刷新幂等及摘要读取索引。
