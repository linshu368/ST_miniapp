# 可执行任务

| ID  | 状态        | 交付                              | 验证                                     |
| --- | ----------- | --------------------------------- | ---------------------------------------- |
| P0  | Done        | 源码、基线、日志与生产版本证据    | research.md、设计复用/风险评估           |
| P1  | Done        | PRD/design/implement/meta最终审核 | logging/mobile/module规划校验            |
| I1  | Done        | 目标聊天路由温热与loading         | 网络限制、容量、去重、离页清理、真实Link |
| I2  | Done        | 关键请求优先与当前会话阶段        | 显式面板操作、跨会话、无新增POST         |
| I3  | Done        | 同visit分段与原日志出口复用       | 原ready不变、后台/失败/敏感字段          |
| V1  | Done        | 既有回归/type/lint/build/复杂度   | 记录实际结果与未运行项                   |
| V2  | Done        | 规范、发布与恢复说明              | 最终diff审核；不自动提交发布             |
| R1  | ReleaseGate | 真实Telegram与稳定release48h      | Android/iOS N≥100，页面/API/失败共同验收 |
