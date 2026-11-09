# 可执行任务分解

| ID  | 状态   | 工作/范围                                         | 依赖     | 验证                            |
| --- | ------ | ------------------------------------------------- | -------- | ------------------------------- |
| T1  | Review | prd/design/implement/research与指标/模块门禁      | 无       | 用户审核后task.py start         |
| T2  | Todo   | generation超长文件按触达职责拆分                  | T1       | focused/typecheck/complexity    |
| T3  | Todo   | 单份新migration：表/权限/validator/CHECK/交付分支 | T1       | SQL shape/权限/并发/旧provider  |
| T4  | Todo   | mapper/repository，请求冻结/身份/响应             | T2,T3    | 白名单/NULL/0/CAS/read-back     |
| T5  | Todo   | execute/upstream/first-token/settle接线           | T4       | 成功/中断/取消/OR胜出/晚到      |
| T6  | Todo   | sync恢复与旧快照兼容                              | T5       | 唯一收费/权限失败/缺数据恢复    |
| T7  | Todo   | 既有PG/PostgREST与@chat场景扩展                   | T3,T5,T6 | 真实SQL/repository/consumer     |
| T8  | Todo   | 文档/spec/module-updates/验证记录                 | T3-T7    | 全量包检查/typecheck/build/lint |
| T9  | Todo   | 全范围复查与发布恢复清单                          | T8       | 最终人审，不自动提交/发布       |

当前仅规划；TEST/Production迁移经仓库workflow分别人工执行，本文件不代表已部署。
