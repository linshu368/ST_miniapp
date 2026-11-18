# 可执行任务分解

状态：用户确认后已启动；T0–T13本地完成，T14待人工、远端、真机与发布窗口验收。

- [x] T0 记录已确认的点赞优先、模型相对热度轮转、三种媒体视图、最新分享时间、推荐无时间加权及P95边界。
- [x] T1 完成复用调查、旧列/旧游标冲突分析、DB落位、可靠性/最小方案/演进恢复与窗口设计。
- [x] T2 最终设计审核，审核通过后task.py start；不提前修改产品代码。
- [x] T3 Shared推荐v2游标契约与旧consumer兼容，扩展既有测试（AC1–AC3）。
- [x] T4 派生排名表、原子重建/读取函数、RLS/ACL、registry及前向迁移（AC1–AC3）。
- [x] T5 本地真实SQL语义、空目录/容量/锁/失败回滚/权限与EXPLAIN验证（AC1–AC3/AC7）。
- [x] T6 Backend推荐RPC、过滤/分页/日志、导入后维护与明确环境的维护入口；latest路径保持独立（AC1–AC3）。
- [x] T7 Frontend版本query key、一次旧游标恢复与失败UI（AC3）。
- [x] T8 页面拆分、稳定最短列、双sentinel单飞、预算/首屏观测/回流恢复（AC4）。
- [x] T9 活动视频加载/释放、一次换签隔离、真实帧/seek/stall有界观测（AC5/AC6）。
- [x] T10 Sentry/Faro名称与维度白名单、API分组、服务端关联与净化回归（AC6）。
- [x] T11 扩展现有@image固定场景：320/390px三页混排/单类型、失败/旧游标/回流/零媒体请求（AC1–AC7）。
- [x] T12 运行既有测试/typecheck/build/lint/复杂度/SQL检查，修复并记录verification.md（AC7）。
- [x] T13 更新README/ARCHITECTURE/模块与运行文档，交付固定窗口查询模板、发布停止条件和恢复步骤。
- [ ] T14 人工审核最终内容；真实TEST/Telegram/Stream/生产P95按环境单独记录，不自动执行生产操作或提交。
