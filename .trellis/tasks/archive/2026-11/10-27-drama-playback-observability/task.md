# 任务分解与当前状态

用户已审阅主方案，任务in_progress；本地实现完成，线上门禁未完成。

- R1 Done：链路/规范/复用与生产日志字段调研，research.md。
- P1 Done：用户审阅通过主路径；附加项未默认执行。
- T1 Partial：本地能力与降级已实现/测试；真实iOS/Android、TEST schema/Preview仍待验收，Grafana已连接并确认生产新对象不存在，见verification.md。
- T2 Done：shared/前端v2，兼容/状态机/网络/帧/长任务验证。
- T3 Local Done：分析表/RPC/repository/ACL/保留期，本地PG17及5万合成样本通过；TEST migration未执行。
- T4 Local Done：独立Grafana JSON与历史导入器；SQL/变量/幂等验证，线上独立骨架已创建且结构查询通过，正式统计渲染/数据导入未做。
- T5 Pending：推送/PR、TEST/Preview、用户真机、独立生产确认与新看板正式统计启用。

实现和验证细节见verification.md，发布和用户真机步骤见docs/grafana/drama-playback-runbook.md。原main未提交内容保持原状。不将本地通过写成线上完成。
