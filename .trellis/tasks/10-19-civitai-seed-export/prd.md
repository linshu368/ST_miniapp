# Civitai seed test SQL export and production bootstrap runbook

## Goal

从 TEST 只读导出未软删除的 civitai_seed 作品及对应 artifact，用于生产初始化；保留标题、模型、tags、完整 snapshot（含中文提示词）、来源和发布时间。用户已确认先编写 SQL 和独立 Storage 迁移方法，不写入生产。

## Requirements

- 不迁移用户、点赞、会话、attempt、账务、运行时配置或 storage.objects；新作品 like_count=0。
- TEST ref 明确为 zoqelpfhurwehlvypryl；只读一致性事务，不经 MCP 读取业务行。
- 导出数据和密钥不入 Git、不输出日志；目标已有一致内容允许重跑，不一致立即回滚，不覆盖。

## Acceptance Criteria

- [ ] SQL 模板、离线导出器、SQL 实际数据文件与 Storage 路径清单。
- [ ] 导出数量/字节/hash 对账、语法检查、适用既有检查；验证受限时明确记录。
- [ ] 图片迁移、目标环境前置检查、生产独立审批和失败恢复说明；本次无生产写入。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design, `implement.md` for execution planning, and `task.md` for the executable task breakdown before `task.py start`.
