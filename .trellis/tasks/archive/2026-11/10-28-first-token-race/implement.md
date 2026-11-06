# 实施与验证

1. 评审规划后启动。engine负责fallback实现和既有fallback测试；data负责attempt内部契约、迁移、现有PG harness测试；admin负责运营/shared/Grafana语义和既有测试；主线程负责generate旧补录删除、execute端到端付费/免费回归和跨层复核。
2. 测试风险：新增/扩展回归是竞态、计费、迁移与权限的必要验证。优先扩展既有文件。覆盖双方先胜/同批、10秒边界、4秒回赢、兜底大于2秒、同型号、失败立即重试、双失败、用户stop/离页、慢DB、diagnostic限长与低调用预算、赢家断流不切第二份。
3. backend/shared/admin相关全量tests、pnpm -r typecheck、frontend/admin build、lint/imports/legacy/migration checks；本地PG17/PostgREST验证CAS与新列权限/duplicate无放大/原费用quota。
4. 最终复核文件清单/差异/验证，按本次明确上线授权提交推送。TEST单文件迁移、合dev、TEST实际SSE与最终账单；CI通过后生产迁移、合main、实际SHA/health/Admin/Grafana核对。
5. 生产有限窗口使用日志与pg_stat_statements增量，不新增监控cron；结果与限制留本地发布记录。未达1%不声称达成。
