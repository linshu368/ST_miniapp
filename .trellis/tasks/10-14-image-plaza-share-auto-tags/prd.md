# 图片广场分享自动打标签

## Goal

用户分享图片到广场时，在客户端未传标签的情况下，由服务端根据生成提示词对照 Admin 已发布的 `image_plaza_tags` 自动绑定相关标签；客户端已传标签时沿用客户端值。

## Confirmed Facts（仓库现状）

- 标签目录：`runtime_config.image_plaza_tags`。
- 作品标签：`experience.image_plaza_works.tags`，经 `billing.share_image_plaza_artifact` 在分享时写入。
- `ShareImagePlazaWorkRequest.tags` 默认 `[]`；Studio 当前写死空数组。
- 打标模型：环境变量 `VENICE_API_KEY` / `VENICE_API_BASE_URL`，默认模型 `deepseek-v4-1-flash`（`IMAGE_PLAZA_TAGGING_MODEL` 可覆盖）；本地经 `VENICE_HTTPS_PROXY` 出站。

## Decisions Locked

| 决策        | 结论                                                                 |
| ----------- | -------------------------------------------------------------------- |
| 时序        | ≤1s 同步带标分享；超时先分享，后台异步补标                           |
| 打标模型    | `VENICE_API_KEY` + `VENICE_API_BASE_URL`，默认 `deepseek-v4-1-flash` |
| 输入        | 只分析提示词，不读图                                                 |
| 费用        | 打标 LLM **不扣用户星尘**                                            |
| 失败        | 最终失败可保持 `tags=[]`，不阻断/不回滚分享                          |
| 客户端 tags | **有值则用客户端且不自动打标；空则自动打标**                         |

## Requirements

1. `POST /api/image-plaza/share`：若 `tags.length > 0`，校验均属启用标签后直接分享，不调用 LLM。
2. 若 `tags` 为空：启动基于提示词的自动打标（Venice 文本模型）；1s 内成功则带结果分享；否则先以 `[]` 分享并返回，后台继续打标，成功后更新该作品 `tags`（仅在仍为空时写入，避免覆盖）。
3. 自动结果只允许启用中的 `image_plaza_tags.id`，去重、有上限（≤12，与契约一致）。
4. 不改变分享返利、幂等、`already_shared`、首次 tip 语义；补标不触发返利。
5. 打标调用不扣用户星尘；超时与错误可观测（pino，无 prompt 全文/密钥）。

## Out of Scope

- Vision / 读图。
- 历史作品批量回填、Admin 改单条 tags。
- 新的 Admin 打标模型配置。
- 前端选标 UI（保持可传 `tags`；Studio 可继续传 `[]` 走自动）。

## Acceptance Criteria

- [ ] 客户端传合法非空 tags → 分享作品 tags 与请求一致，无 LLM 调用。
- [ ] 客户端 tags 为空且 1s 内打标成功 → 响应作品含合法启用 tags。
- [ ] 客户端 tags 为空且超过 1s → 分享仍成功；随后后台补写非空合法 tags（若仍为空）。
- [ ] 打标失败（同步+异步）→ 作品可为 `[]`，分享与返利不受影响。
- [ ] 非法客户端 tag id → 400，不分享。
- [ ] 重复分享幂等；补标不重复发返利。
- [ ] 不下载 Storage 原图；不记录完整 prompt/密钥到日志。
