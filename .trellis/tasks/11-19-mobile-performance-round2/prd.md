# 冷启动、会话和创作性能第二轮优化

## 目标与用户价值

根据最近48h生产Grafana/Sentry和用户指定两份周末/工作日报告，降低冷启动、聊天与会话、角色创作、影像创作的真实等待和失败；分批改动并可独立回滚。

## 已确认背景

[证据与数据边界](research/evidence.md)为唯一事实来源；窗口2026-11-17 15:10:52—2026-11-19 15:10:52。此前rewrite/critical/身份singleflight已存在。Sentry指出detail取消、身份失败、UUID兼容问题；新窗口创作/影像若干组低样本，不能夸大收益。

## 需求

- G1 分Android/iOS、导航/冷开/挂载/生成阶段规划和验收，保留成功N、真实失败、取消、后台、低样本与缺样本。
- G2 完成四个子任务，针对确证原因修复，技术未证实处先定位；不重复做旧提交、不以提前ready/隐藏错误改善数字。
- G3 保持权限、会话版本、草稿隔离与恢复、计费和外部写入幂等；不建新服务/数据库对象，不改审核或UX。
- G4 复用既有fixed UI fixtures与日志、共享契约及内部helpers，新增测试仅限风险评估明确的取消与租约回归。

## 验收

- [ ] G1 [冷启动端到端瓶颈与关键链整改](../11-19-cold-start-round2/prd.md)的全部验收完成；每批有独立验证和恢复说明。
- [ ] G2 [聊天详情取消分类与会话读取可靠性](../11-19-conversation-read-reliability/prd.md)的全部验收完成；每批有独立验证和恢复说明。
- [ ] G3 [角色创作兼容性与编辑器首屏优化](../11-19-creator-editor-performance/prd.md)的全部验收完成；每批有独立验证和恢复说明。
- [ ] G4 [影像创作首屏与视频交付恢复优化](../11-19-media-creation-performance/prd.md)的全部验收完成；每批有独立验证和恢复说明。
- [ ] 全范围质量检查和模块知识回写经最终人工审查；无未披露失败/无法运行项。
- [ ] 生产发布按单独授权进行；新release真实24—48h及足够N之前，不把本地结果称线上改善。

## 范围外

不自动commit/push/部署/生产配置写入或数据库迁移；不恢复已退役聊天配图；不为未证实瓶颈增缓存或调度平台；不把视频模型生成时长归为页面优化收益。

## Local delivery status

User approved implementation on 2026-11-19. Local code and automated verification are complete; see [verification.md](verification.md). Production P95, real Telegram and Railway termination acceptance remain pending. Task is in review; no commit or deployment performed.
