# Task Breakdown

## Status Legend

- Todo / Doing / Done / Blocked / Skipped

## Tasks

| ID  | Status  | Task                          | Files / Scope                       | Depends On  | Verification                           |
| --- | ------- | ----------------------------- | ----------------------------------- | ----------- | -------------------------------------- |
| T0  | Done    | 规划收口：原型对齐 + 冲突确认 | `prd.md` `design.md` `implement.md` | -           | Q1–Q8 已拍板；摘要已确认；**实施暂缓** |
| T1  | Blocked | 契约与 migration 设计冻结     | shared + migrations                 | T0          | 八域评审通过                           |
| T2  | Todo    | Backend 创作/报价/结算        | backend features/routes             | T1          | 失败不扣；quote 一致                   |
| T3  | Todo    | Backend 广场/分享返利         | backend + billing RPC               | T1          | 幂等返利；即时上架                     |
| T4  | Todo    | Frontend 广场+详情+用同款     | frontend                            | T3 契约可用 | 对照原型 AC01–05                       |
| T5  | Todo    | Frontend 创作流+操作          | frontend                            | T2          | AC06–09                                |
| T6  | Todo    | 分享弹窗状态机                | frontend+backend                    | T0 Q1, T3   | AC12                                   |
| T7  | Todo    | Admin 三页                    | admin                               | T1          | AC13–14                                |
| T8  | Todo    | 聊天入口移除与兼容            | frontend+backend                    | T2          | AC15                                   |
| T9  | Todo    | 探索环境验收与记录            | 全栈                                | T4–T8       | AC16                                   |

## Execution Log

- 2026-10-10：按原型重写规划；交互权威改为原型 HTML；列出 Q1–Q8 待确认；补充 design/implement 与复用调研。
- 2026-10-10：Q1 确认方案 C——开关开且账号未完成首次分享时，仅点击分享弹窗；确认分享后永久不弹；✕ 后下次仍弹；开关关永不弹；生成成功不自动弹。
- 2026-10-10：Q2 确认——弹窗无金额占位符；`{rate}`/`{model}`；百分比 runtime_config；具体返利 = 实扣×比例，仅成功轻提示。
- 2026-10-10：Q3 确认 B——切到不支持图生图的模型时清除参考图，toast 告知已改为文生图。
- 2026-10-10：Q4 确认 A——创作页默认 seedream-v5-pro；加参考图不强制换模；不支持则阻止添加。
- 2026-10-10：Q5 确认 B——Admin 三页与其他菜单一致：草稿→发布→回滚。
- 2026-10-10：Q6 确认 C——不做审核/举报/下架页；分享成功即返；不追回返利。
- 2026-10-10：Q7 确认按需求——文生图 3.12 档 + edit 固定上架价；不用原型 +10/+20。
- 2026-10-10：Q8 确认 A——10 模型全上；Anime 业务 ID anime-wai；风格先 None；PRD 收敛并提交最终规划摘要。
- 2026-10-10：用户确认规划，**先不实施**；保持 `planning`，不 `task.py start`。
