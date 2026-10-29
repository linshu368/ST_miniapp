# 本地验证与交付边界

2026-10-29，独立worktree，基线73be921048407249c896db5332c93426ee1fc996（用户明确批准），分支codex/drama-slow-diagnostics-loki。原main工作区未提交修改未改动。

## 已通过

- Node22.20.0、pnpm9.15.9，frozen安装，无lockfile改动，生成Prisma Client。
- Backend全量107文件/1038 tests；shared全量17文件/186 tests。
- 最终相关OTLP/telemetry回归2文件/17 tests：真实HTTP接收OTLP JSON正文，完整media/queries/marks/limited信息、4999/5000/6000/16007边界、终态/网络关联、未知敏感字段拒绝、出口关闭和401/队列溢出隔离；旧DB flag开启/数据库不可用/突发请求仍无RPC。
- pnpm -r typecheck：shared/backend/reply-renderer/ui-tests/admin/frontend通过。首次发现测试断言重复id，已修复并完整复跑通过。
- pnpm -r --if-present build：Frontend/Admin通过，Backend无build脚本，以typecheck验证。原有img/Browserslist/Admin大chunk告警未扩范围处理。
- pnpm lint:imports、修改文件Prettier、git diff --check通过。
- 看板JSON解析、唯一面板/变量ID、Loki目标/服务与环境作用域校验通过。两个最终LogQL查询经Cloud只读请求接受，无新事件返回符合尚未部署状态；不是Cloud送达证据。
- Trellis上下文4项/文件校验通过；本任务module-updates目标hash/证据路径/模块范围校验通过。

## 既有阻塞与剩余边界

全局module_knowledge.py check被上游frontend/business/drama-experience.md缺少“当前状态”章节阻塞；该文件不在本次范围。本任务payload单独验证通过，未修改上游文档绕过检查。

本轮未新增或执行数据库migration；无新服务/凭证/配置变量。未git add/commit/push、未创建PR、未部署、未修改线上看板。需要发布Backend并将原工程短剧看板新增两面板/变量合入当前线上JSON（保留线上其他改动）。发布后用自然慢样本验证Cloud能查到终态与network，不要求手工复现/抓包。

202只表示接收；OTLP队列关闭/过载/断网、强退仍可能缺报。iOS详细首字节不可读时保持limited，本次不增加媒体代理/探测或绕过平台限制。Loki保留期按实际Cloud设置，未假设SQL的7/14天适用于它。历史Supabase记录/导入器保留；新路由不再写库。回退旧Backend前关闭旧持久化flag需要独立配置授权。
