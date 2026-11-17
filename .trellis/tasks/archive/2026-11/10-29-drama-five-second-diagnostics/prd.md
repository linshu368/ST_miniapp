# 短剧慢启动诊断写入 Grafana Cloud

用户已批准常态采集，并在本轮进一步指定：不新增五秒快照，不将诊断数据写入Supabase，优先存Grafana Cloud。手工抓包跳过。

## 完成标准

- 复用现有启动观察，从真实成功/失败/离开/后台结果按实际耗时筛选达到五秒的诊断；不因阈值中断播放。
- 诊断详情经既有后端鉴权入口和已有工程OTLP出口存Grafana Cloud Loki；同一observation关联迟到媒体信息。受限字段不补零，不上传URL/token/身份。
- 本功能不再新增Supabase分析写入；历史表和记录不删除。旧看板保留历史用途。
- 原看板或最小Loki查询可按版本、平台、入口、实际等待与观察ID追查媒体/API事件。
- 本地实现/测试与线上发布分别验收，不将日志出口存在当成本功能已接入。

## 当前状态

Supabase迁移及五秒timer产品草稿已全部撤回，tracked工作区干净。只读确认Cloud已有grafanacloud-logs；生产st-miniapp-backend日志中有drama.request_timing，release=73be9210。该已上线工程出口位于origin/codex/grafana-performance-observability，尚未包含于origin/dev；不能无意将122文件的上游增量带入本次PR。用户已明确允许基于已上线73be921继续，当前独立分支codex/drama-slow-diagnostics-loki。
