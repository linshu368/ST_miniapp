# Design: 图片广场分享自动打标签

## 方案摘要

在 `POST /api/image-plaza/share` 内分支：

1. **客户端 `tags.length > 0`**：校验启用集合后直接 `shareArtifact`（现状逻辑），**不调 LLM**。
2. **客户端 `tags` 为空**：用 attempt 提示词 + 启用标签列表调用 `image_text_model_config` 做分类；`Promise.race` 2s：
   - 先完成 → 带过滤后的 tags 分享；
   - 超时 → 以 `[]` 分享并立即返回，后台继续同一 Promise，成功后 `UPDATE works.tags`（仅当 `tags = '{}'`）。

## 复用调研

| 能力                                                    | 结论                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `image_plaza_tags` / share RPC                          | 复用；不改返利与幂等                                                                                                                |
| `resolveImageTextModelConfig` / `getImageRuntimeConfig` | 复用配置读取                                                                                                                        |
| `generation/image-upstream.callDeepSeek`                | **私有**；同类 OpenAI-compatible 文本调用。优先抽出小 helper 或在 plaza 内仿照实现，**不**走 `execute()` 计费闸门（已确认不扣星尘） |
| Vision / Storage 下载                                   | **不复用**（明确不读图）                                                                                                            |
| 新队列/worker                                           | **不做**；用 request 内 `void` 后台延续 + 日志即可（进程内足够 MVP）                                                                |

拒绝：为打标新建 runtime key、异步表、通用标签服务框架。

## 可靠性

| 项     | 处理                                                                                       |
| ------ | ------------------------------------------------------------------------------------------ |
| 超时   | 打标专用超时（建议 ≤8–15s 总超时）；分享路径 2s race                                       |
| 重试   | 不自动重试 LLM（非幂等计费风险低但无必要）；补标失败只打日志                               |
| 幂等   | share RPC 不变；补标 `WHERE id=? AND user_id=? AND tags='{}'`                              |
| 并发   | 同 artifact 重复分享仍 already_shared；补标不写返利                                        |
| 降级   | 模型未配置/解析失败 → 当作打标失败 → `[]`                                                  |
| 可观测 | `image_plaza.tagging.*` 事件：耗时、同步/异步、tag 数量、错误码；不记 prompt 全文与 apiKey |

## 核心流程

```
share(request)
  runtime = requireEnabled()
  enabled = runtime.tags.filter(enabled)
  if request.tags.length > 0:
    validate ⊆ enabled → shareArtifact(tags=request.tags) → return
  prompt = loadAttemptPrompt(artifact)
  taggingPromise = classifyTags({ prompt, enabledTags, textModel })
  raced = await race(taggingPromise, 2000ms)
  if raced.done:
    shareArtifact(tags=sanitize(raced.tags)) → return
  result = shareArtifact(tags=[]) → reply
  void taggingPromise.then(tags => updateTagsIfEmpty(workId, sanitize(tags)))
  return result
```

## LLM 契约（实现约定）

- System：只允许从给定 id 列表多选；输出 JSON 数组（纯 id）。
- User：提示词截断到安全长度（如 2000 字内已有上限）+ 标签 `id/label` 列表。
- 解析失败或非子集 → 视为失败（空结果）。

## 数据 / Migration

- **无需**新表。可选：无 migration，repository 直写 `experience.image_plaza_works`（与现有 service role 一致）。
- 若团队偏好 RPC：可补 `experience.set_image_plaza_work_tags_if_empty`；默认直写即可。

## 契约 / Frontend

- `ShareImagePlazaWorkRequest.tags` 语义保留：有值=手动，空=自动。
- Studio 可继续传 `[]`；无需本轮 UI。
- 响应 `work.tags` 在同步成功路径反映结果；异步路径首次响应可为 `[]`。

## 演进与回滚

- 发布：仅 backend（+ 可选 shared 注释）；无 DB 强制顺序。
- 回滚：去掉打标分支即恢复「空 tags 分享」；已补标数据可保留。
- 停止条件：文本模型错误率过高 → 临时跳过自动打标（feature 内短路返回 []）。

## 验证

- 单测：有客户端 tags / 空 tags 同步成功 / race 超时后补标 / 非法 id / sanitize。
- 人工：Studio 分享；Admin 改 tags 后新分享命中新列表。
