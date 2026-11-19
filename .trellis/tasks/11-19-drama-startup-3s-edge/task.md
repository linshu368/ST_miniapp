# Tasks：短剧双端起播 ≤3s（修订 + 附加 A–G）

| ID  | 状态 | 内容                                                                      | 依赖  |
| --- | ---- | ------------------------------------------------------------------------- | ----- |
| T0a | Todo | Faro 重算 #932 后基线                                                     | —     |
| T0b | Todo | 详情 hydrate 不挡播放器                                                   | —     |
| T0c | Todo | 首页 switch / 选集 / 续集 intent                                          | —     |
| T0d | Todo | **D** 片库预取 `/dramas/:id` 路由 chunk                                   | —     |
| T1  | Todo | shared 诊断 segments/init + delivery_path；**A** 契约字段（若本期做内联） | T0a   |
| T2  | Todo | iOS 默认 hls.js                                                           | T1    |
| T3  | Todo | 客户端首块预取 + frag loader + **E** priority                             | T1    |
| T4  | Todo | 缓冲水位 / ABR / rebuffer 降档                                            | T3    |
| T4b | Todo | **C** 按下让带宽；**F** 动态封面预取数 ≤6                                 | T3    |
| T4c | Todo | **B** 片尾预取升级为 play+清单+首块                                       | T3    |
| T4d | Todo | **A** 后端起播子清单内联（miss 不长阻塞）                                 | T1    |
| T4e | Todo | **G** 最低档 4s 体积审计记 notes                                          | —     |
| T5  | Todo | Backend `edge_ticket` + KV；Worker 验票签名；灰度                         | T1    |
| T6  | Todo | 前端持票优先边缘，过期续票/回退                                           | T5    |
| T7  | Todo | 首片边缘预热 Cron                                                         | T5    |
| T8  | Todo | 双端 7 天门禁验收（含 A8–A10）                                            | T0–T7 |
| T9  | Todo | （可选）R2 E2 / H–L                                                       | T8    |

## PR 切片

1. **PR-A0**：T0b + T0c + T0d（+ T0a 记录）
2. **PR-A**：T1–T4 + T4b + T4c（客户端主路径）
3. **PR-A2**：T4d 子清单内联（可与 PR-A/B 并行）；T4e 审计笔记可同 PR 或独立 docs
4. **PR-B**：T5–T6 边缘签
5. **PR-C**：T7 首片预热
6. **PR-D**：T8 报告；必要时 T9

底座：#932。旁路快进只回归。说明文档 §9 与 `design.md` §3.5 为附加项权威说明。
