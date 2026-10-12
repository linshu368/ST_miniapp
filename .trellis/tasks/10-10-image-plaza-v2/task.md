# Task Breakdown

## Status Legend

- Todo / Doing / Done / Blocked / Skipped

## Tasks

| ID  | Status  | Task                               | Files / Scope                          | Depends On  | Verification                       |
| --- | ------- | ---------------------------------- | -------------------------------------- | ----------- | ---------------------------------- |
| T0  | Done    | 规划收口：原型对齐 + 冲突确认      | `prd.md` `design.md` `implement.md`    | -           | Q1–Q12-rev；已获实施授权           |
| T1  | Done    | 独立契约 image-plaza + migration   | shared `api/image-plaza*` + migrations | T0          | 八域已终审；不改 `api/images.ts`   |
| T2  | Done    | Backend image-plaza 创作/报价/结算 | `features/image-plaza` + routes        | T1          | 失败不扣；与 `features/image` 隔离 |
| T3  | Done    | Backend 广场/分享返利              | image-plaza + billing RPC              | T1          | 幂等返利；即时上架                 |
| T4  | Done    | Frontend 广场瀑布流+详情+用同款    | `/create` 直接广场；隐藏 wish 入口     | T3 契约可用 | AC01；吸顶去创作                   |
| T5  | Done    | Frontend 创作流+操作               | 同上独立模块                           | T2          | AC06–09                            |
| T6  | Done    | 分享弹窗状态机                     | frontend+backend                       | T0 Q1, T3   | AC12                               |
| T7  | Done    | Admin 三页                         | admin                                  | T1          | AC13–14                            |
| T8  | Skipped | 聊天看看TA（入口已配置关闭）       | —                                      | —           | Q9：本期不处理                     |
| T9  | Doing   | 探索环境验收与记录                 | 全栈                                   | T4–T7       | 静态验证完成；待 test DB/真机联调  |

## Execution Log

- 2026-10-10：按原型重写规划；交互权威改为原型 HTML；列出 Q1–Q8 待确认；补充 design/implement 与复用调研。
- 2026-10-10：Q1 确认方案 C——开关开且账号未完成首次分享时，仅点击分享弹窗；确认分享后永久不弹；✕ 后下次仍弹；开关关永不弹；生成成功不自动弹。
- 2026-10-10：Q2 确认——弹窗无金额占位符；`{rate}`/`{model}`；百分比 runtime_config；具体返利 = 实扣×比例，仅成功轻提示。
- 2026-10-10：Q3 确认 B——切到不支持图生图的模型时清除参考图，toast 告知已改为文生图。
- 2026-10-10：Q4 确认 A——创作页默认 seedream-v5-pro；加参考图不强制换模；不支持则阻止添加。
- 2026-10-10：Q5 确认 B——Admin 三页与其他菜单一致：草稿→发布→回滚。
- 2026-10-10：Q6 确认 C——不做审核/举报/下架页；分享成功即返；不追回返利。
- 2026-10-10：Q7 确认按需求——文生图 3.12 档 + edit 固定上架价；不用原型 +10/+20。
- 2026-10-10：Q7-rev——有参考图（添加/编辑）也走 Admin「上架星尘价」，与文生图同价；取消 edit 额外档位表与 +10/+20。
- 2026-10-12：Q12——现有底栏「创作」Tab（`/create`）即图片创作广场入口；替换「即将上线」占位；许愿池保留。
- 2026-10-12：Q12-rev——创作 Tab 直接广场瀑布流；吸顶「图片广场」+「去创作」；底栏保留；不再需要许愿池路径。
- 2026-10-12：Q12-rev2——用户最新决定保留原许愿池；广场顶部「许愿池」位于「去创作」左侧，`/create/wish` 与原流程继续保留。
- 2026-10-12：Q12-rev3——保留 `/create/wish` 与原许愿流程，但当前先隐藏许愿池可见入口；其余实现不变。
- 2026-10-10：Q8 确认 A——10 模型全上；Anime 业务 ID anime-wai；风格先 None；PRD 收敛并提交最终规划摘要。
- 2026-10-10：用户确认规划，**先不实施**；保持 `planning`，不 `task.py start`。
- 2026-10-10：Q9——角色聊天「看看TA」本期不处理（入口已配置关闭）；移出 R10/AC15 实施项。
- 2026-10-10：Q10——图片创作广场前后端业务独立成块，不与既有聊天图片生成混用。
- 2026-10-10：弹窗 UI 改为上=用户成图、中=运营文案、下=分享按钮；「不再提示」待 Q11。
- 2026-10-10：Q11 确认 B——不做「不再提示」，状态机保持 Q1-C。
- 2026-10-12：用户明确授权开始实施；八域归属终审通过；Venice 官方模型页核验 `anime-wai -> wai-Illustrious`；T1 开始。
- 2026-10-12：T1–T7 本地实现完成；trellis-check 修正 Venice edit 协议、模型尺寸策略、报价映射快照、幂等冲突、公开参考图授权与数据库深层校验。
- 2026-10-12：Shared/Backend/Frontend/Admin 共 1050 项现有测试通过；全仓 typecheck、Frontend/Admin build、lint、migration 文件名、import 边界和模块知识载荷通过。Frontend 仅保留签名图片 `<img>` 性能警告，Admin 仅保留既有大 chunk 警告。
- 2026-10-12：本机无 Docker/psql，且会话无可用 Browser；migration 仅静态审查，尚未在明确 test 环境执行，Telegram WebView/移动端与真实 Venice/Storage/钱包链路待人工联调，因此 T9 保持 Doing。
