# 总任务分解

| ID  | 状态      | 交付                                                                               | 依赖/验收                                |
| --- | --------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| P0  | Done      | 固定48hGrafana/Sentry证据、两份旧报告与当前代码复核                                | research/evidence.md/json                |
| P1  | LocalDone | 最终规划审核与三项meta校验                                                         | 用户批准最新摘要后才start子任务          |
| P2  | LocalDone | [冷启动端到端瓶颈与关键链整改](../11-19-cold-start-round2/task.md)                 | 继承P0证据；独立验收，按共享文件串行集成 |
| P3  | LocalDone | [聊天详情取消分类与会话读取可靠性](../11-19-conversation-read-reliability/task.md) | 继承P0证据；独立验收，按共享文件串行集成 |
| P4  | LocalDone | [角色创作兼容性与编辑器首屏优化](../11-19-creator-editor-performance/task.md)      | 继承P0证据；独立验收，按共享文件串行集成 |
| P5  | LocalDone | [影像创作首屏与视频交付恢复优化](../11-19-media-creation-performance/task.md)      | 继承P0证据；独立验收，按共享文件串行集成 |
| P6  | LocalDone | 全范围质量/模块知识和最终审查                                                      | 全部子验收；不自动commit/push            |
| P7  | LocalDone | 获授权后TEST/生产发布与24—48h P95复核                                              | 应用验证完成且单独部署授权；N<100延至72h |

实施未开始。父/子关系不代替依赖：四个子任务无其他业务结果前置，但先实施者的shared文件改动必须由后实施者重读适配。冷启动无证据时禁止修改CDN策略，视频未知结果禁止强制释放保护。
