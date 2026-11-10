# 可执行任务分解

| ID  | 状态    | 工作/范围                                           | 依赖     | 验证                                                                        |
| --- | ------- | --------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| T1  | Done    | 用户2026-11-10确认规划，门禁通过并start             | 无       | task.json为in_progress                                                      |
| T2  | Done    | 拆分execute/sync/models触达职责                     | T1       | 既有回归、类型检查及复杂度门禁通过；只收紧本次文件基线                      |
| T3  | Done    | 新表、权限、冻结/合并/领取RPC、validator/CHECK/交付 | T1       | 隔离PG18 WASM迁移重放/权限/身份/胜负场景通过                                |
| T4  | Done    | 逐字段清单、mapper/repository、分来源capture        | T2,T3    | 类型/零值/精度/容量/缺口/敏感排除回归通过                                   |
| T5  | Done    | 生成接线、非流/流、身份失败正文保留、诊断隔离       | T4       | focused与后端全量测试通过                                                   |
| T6  | Done    | 胜者校验、旧快照及独立有界详情恢复                  | T5       | 单次收费、权限失败、过期与缺ID场景通过                                      |
| T7  | Partial | 已扩展SQL与@chat/@surplus本地验收                   | T3,T5,T6 | SQL隔离及29项浏览器验收通过；原生PG17/PostgREST/多连接/真实供应商待外部环境 |
| T8  | Done    | README/架构/spec/module-updates/验证与发布清单      | T3-T7    | 见verification.md；Windows既有CLI权限断言失败单列                           |
| T9  | Review  | 全范围agent检查问题已修复，内容待工程师最终审阅     | T8       | 不自动提交、归档、迁移、发布                                                |

本地实现已完成，验证详情见verification.md；TEST/Production迁移按release-checklist.md分别执行，本文件不代表已部署。
