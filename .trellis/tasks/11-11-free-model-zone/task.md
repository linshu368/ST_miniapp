# Task Breakdown

| ID  | Status  | Task                                   | Scope                               | Depends On | Verification                                        |
| --- | ------- | -------------------------------------- | ----------------------------------- | ---------- | --------------------------------------------------- |
| T1  | Done    | 配置与公开契约                         | shared, admin-client                | -          | shared test, `pnpm -r typecheck`                    |
| T2  | Done    | 状态表、事件表与指标函数迁移           | packages/shared/migrations          | T1         | 本地 SQL 场景，TEST 执行                            |
| T3  | Done    | Surplus 公开接口客户端                 | backend features/free-zone          | -          | 超时、404、null 处理                                |
| T4  | Done    | 评估纯函数与评估任务                   | backend features/free-zone          | T2,T3      | 纯函数单测（需同意）、TEST 跑一轮                   |
| T5  | Done    | 栏目快照、目录与选择接口、自动换模型   | backend routes/models, text-billing | T1,T4      | 接口场景、替换顺序                                  |
| T6  | Done    | 生成：首字参数、折扣底线、白名单、扣 0 | backend generation                  | T5         | TEST 核对请求与扣费                                 |
| T7  | Done    | 前端栏目、换模型提示、到点刷新         | frontend                            | T1         | 390/320 截图                                        |
| T8  | Done    | ui-tests 场景                          | ui-tests                            | T7         | `pnpm preview:ui`                                   |
| T9  | Blocked | Grafana 畅聊面板（等迁移上生产）       | Grafana 看板                        | T2         | 面板数字与任务快照一致                              |
| T10 | Doing   | 收尾验证与发布                         | -                                   | T1-T9      | typecheck/lint/test/lint:complexity；按发布顺序上线 |

## Execution Log

- 2026-11-11 策略讨论定稿，规划写完，等用户审阅。不写产品代码。
- 2026-11-11 用户确认：选择按用户存（现状不改）；栏目对所有卡显示，使用范围做成参数；指标放 Grafana；第一版整周免费，不做每周时段；同意加单测和 @free-zone 验收。
- 2026-11-11 第一版实现完成（未提交）：
  - 本地已验证：PG17 迁移测试；后端 1575、shared 233、前端 758、admin-client 19、admin-cli 24 个测试；`pnpm -r typecheck`、前端 lint、复杂度门禁；`@free-zone` 7 个用例。
  - `@chat` 里有 2 个用例失败（Surplus 兜底、最近十轮编辑），在基线 d029031e 上同样失败，与本任务无关。
  - 待做：同步最新 dev、提交/PR、TEST 迁移、Grafana 面板。
- 2026-11-11 按用户反馈修改：
  - 供应商改成单家粘住 + 价格分档（默认 3 倍）选首字最快；不达标或业务越线时按同一规则顺延，全不行才下架；业务越线的那家排除 24 小时，业务指标从 `provider_since` 起算；去掉 `max_providers`。
  - 去掉换模型提示（`selection_notice`）；评估任务拉行情限并发 4。
  - 复验全部通过：后端 1578、shared 233、前端 758、admin 43 个测试；typecheck/lint/复杂度；PG17 迁移；`@free-zone` 7 个用例。
- 2026-11-11 合入最新 origin/dev（只有迁移 README 冲突，两节都保留），复验通过；推送并开 PR #745 → dev（未合并）。
