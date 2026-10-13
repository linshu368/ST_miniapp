# Task Breakdown

## Status Legend

- Todo / Doing / Done / Blocked / Skipped

## Tasks

| ID  | Status  | Task                               | Files / Scope                          | Depends On    | Verification                        |
| --- | ------- | ---------------------------------- | -------------------------------------- | ------------- | ----------------------------------- |
| T0  | Done    | 规划收口：原型对齐 + 冲突确认      | `prd.md` `design.md` `implement.md`    | -             | Q1–Q12-rev；已获实施授权            |
| T1  | Done    | 独立契约 image-plaza + migration   | shared `api/image-plaza*` + migrations | T0            | 八域已终审；不改 `api/images.ts`    |
| T2  | Done    | Backend image-plaza 创作/报价/结算 | `features/image-plaza` + routes        | T1            | 失败不扣；与 `features/image` 隔离  |
| T3  | Done    | Backend 广场/分享返利              | image-plaza + billing RPC              | T1            | 幂等返利；即时上架                  |
| T4  | Done    | Frontend 广场瀑布流+详情+用同款    | `/create` 直接广场；隐藏 wish 入口     | T3 契约可用   | AC01；吸顶去创作                    |
| T5  | Done    | Frontend 创作流+操作               | 同上独立模块                           | T2            | AC06–09                             |
| T6  | Done    | 分享弹窗状态机                     | frontend+backend                       | T0 Q1, T3     | AC12                                |
| T7  | Done    | Admin 三页                         | admin                                  | T1            | AC13–14                             |
| T8  | Skipped | 聊天看看TA（入口已配置关闭）       | —                                      | —             | Q9：本期不处理                      |
| T9  | Doing   | 探索环境验收与记录                 | 全栈                                   | T4–T7         | 静态验证完成；待 test DB/真机联调   |
| T10 | Done    | 初始广场数据只读审计与规划补充     | PRD/design/implement/research          | T1–T7         | 8,227 行聚合审计；未改产品代码/数据 |
| T11 | Todo    | 初始数据 schema/契约/同款兼容层    | shared/backend/frontend/database       | T10、单独授权 | AC17–AC21；迁移先在 test 验证       |
| T12 | Todo    | 离线 importer 与来源/内容门禁      | backend tooling/Storage/导入清单       | T11、门禁关闭 | dry-run、幂等、补偿、脱敏           |
| T13 | Todo    | test canary 与分批初始数据导入     | test DB/Storage/人工回归               | T12           | AC18–AC24；production 另行授权      |

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
- 2026-10-13：补充图片广场专项回归：Shared 模型/配置契约 5 项、Backend Venice generate/edit 协议与未知结果 4 项；完整 Shared 122 项、Backend 607 项通过。
- 2026-10-13：目标库首次执行 migration 在重建 `config_drafts_config_key_check` 时触发 23514，事务整体回滚。根因为用 managed-key 函数重建静态 CHECK 会收窄目标库历史白名单；已改为读取目标库当前约束表达式后单调 OR 追加四个新 key，并保留原 `convalidated` 状态和增加自检，等待目标 test 环境重试。
- 2026-10-13：兼容修复后 migration lint、`git diff --check`、Trellis context/module knowledge、全仓 typecheck 通过；Shared 122 项与 Backend 607 项全量测试再次通过。目标 test DB 尚未重跑，T9 继续保持 Doing。
- 2026-10-13：按 `图片广场的图片.md` 与 `civitai_venice_nsfw_combined.xlsx` 补充初始数据规划。只读审计确认 8,227 行、6 模型、ID/URL 唯一且字段完整；3,458 条提示词超过当前 600 字，184 条超过对应 Venice 模型上限；图片实际 MIME 与 `.jpeg` URL 后缀不总一致，60 条样本推算原图约 19.4 GiB。已形成 schema/脱敏/同款/幂等转存/内容来源门禁和恢复方案；共享抓取会话正文当前不可访问。本轮未修改产品代码、migration 或数据库，T11–T13 等待单独实施授权及门禁关闭。
- 2026-10-13：用户将提示词规划上限修订为统一 1,000 字，不采用模型级动态放宽。工作簿中 6,742 条（82.0%）可保留完整提示词进入后续校验，超过 1,000 字的 1,485 条隔离且不截断；本轮仍仅修改规划文档。
- 2026-10-13：用户再次修订为 Frontend 手工输入 1,000 字、作品快照/数据库/模型调用链 2,000 字。长度阶段可覆盖 8,054 条（97.9%），超过 2,000 字的 173 条隔离；1,001–2,000 字的原样用同款由 Backend 按 `source_work_id` 读取权威快照，避免经过前端输入框截断。上游模型仍需 canary 实测，本轮未改代码或数据。
- 2026-10-13：用户最终将 Frontend 手工输入框也放大到 2,000 字，形成 textarea/shared/Backend/snapshot/DB/model call 全链路统一上限；撤销 1,000/2,000 双层契约及只读长提示词特殊路径。“用同款”可直接恢复、编辑和提交不超过 2,000 字的完整提示词。本轮仍未改代码或数据。
