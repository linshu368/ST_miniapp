# Task Breakdown

## Tasks

| ID  | Status | Task                                                                                     | Files / Scope                            | Verification                                              |
| --- | ------ | ---------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| T1  | Done   | 新增续播对齐/目标解析纯函数，`loadDramaSource` 增加可选 `startPosition`                  | `lib/drama-media-source.ts`              | 单测 12 条通过                                            |
| T2  | Done   | 媒体加载 effect 接线 `startPosition`，`onLoadedMetadata` 改用统一目标解析并跳过重复 seek | `components/drama/drama-player.tsx`      | typecheck + lint                                          |
| T3  | Done   | `preloadDramaHls()` 延后到首帧绘制+一次空闲后触发                                        | `drama-home.tsx`、`dramas/[id]/page.tsx` | typecheck                                                 |
| T4  | Done   | 更新 drama-experience 规格文档说明新行为                                                 | `.trellis/spec/.../drama-experience.md`  | 人工复核                                                  |
| T5  | Done   | 执行全量适用验证                                                                         | frontend                                 | typecheck/test(740)/lint/build/complexity/diff-check 通过 |

## Execution Log

- 2026-11-09：基于生产 Grafana 数据确认续播 ABR 误判根因与会话首播预加载抢带宽问题；完成 prd/design/implement 规划，`mobile_performance` 门禁通过，用户确认待拍板项（补单测、更新 spec 现在做；`drama-player.tsx` 拆分暂缓）。
- 2026-11-09：完成三处代码改动（续播对齐、hls.js startPosition、预加载调度）及配套单测；Frontend typecheck、740 用例、lint、build 通过；`pnpm lint:complexity` 退出码 0（`drama-player.tsx` 存量超标项增长，不阻断，已记为暂缓事项）；`next lint` 唯一相关警告确认是 origin/main 已有的预存警告。发布后验证待生产数据，见 implement.md。
