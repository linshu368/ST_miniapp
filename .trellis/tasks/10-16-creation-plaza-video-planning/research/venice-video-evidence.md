# Venice 视频接口与模型证据（2026-10-24 采集）

来源（公开、无鉴权）：

- `GET https://api.venice.ai/api/v1/models?type=video`（137 个模型；经本机代理下载，原始 JSON 未入库）
- `https://docs.venice.ai/api-reference/endpoint/video/{queue,retrieve,quote,complete}.md`
- `https://docs.venice.ai/guides/media/video-generation.md`

以上只是**文档证据**，没有用真实 key 调用过，价格也没有实测。

## 1. 接口要点

| 接口 | 要点 | 对本设计的影响 |
| --- | --- | --- |
| `POST /video/quote` | 输入 model/duration/resolution/aspect_ratio/audio，返回 `{quote: USD}`；报价参数**不会**转发到 queue | 后端按 USD 换算星尘作为权威价；quote 结果缓存，并定时刷新 |
| `POST /video/queue` | 必填 `model`、`duration`；可选 `prompt`（各模型上限不同）、`negative_prompt`、`aspect_ratio`、`resolution`、`audio`（默认 true）、`image_url`、`reference_image_urls`（≤30）；返回 `{model, queue_id, download_url?}`，其中 `download_url` 有效 24h；**未知字段返回 400** | 每个模型只发它支持的字段；保存 `queue_id`/`download_url` 后才能确认“已提交” |
| queue 错误码 | 400 参数错误、402 Venice 余额不足、409 `needs_consent`（Seedance 系）、413 超过 25MB、422 内容违规、429 限流/过载、500、503 模型离线 | 422 归为审核拒绝（refund）；402/409/413 不重试，直接失败并退款 |
| `POST /video/retrieve` | 入参 `model`、`queue_id`、`delete_media_on_completion`；处理中返回 JSON `{status:"PROCESSING", average_execution_time, execution_duration}`（毫秒）；完成后要么返回 `video/mp4` 二进制，要么返回 JSON `COMPLETED`，此时需 GET `download_url` | worker 轮询需区分 Content-Type；轮询间隔 ≥5s |
| retrieve 错误码 | 400 queue_id 未知；404 媒体过期或已删；422 `{type:"provider_content_policy", credits_refunded:true}`；429/500/503 需退避重试 | 422 记为 `moderation_rejected` 并退款；404 记为 `expired` 并退款；连续 5xx 直到 deadline 后记为 `failed_unknown`，需人工对账 |
| `POST /video/complete` | 下载成功后删除上游媒体；也可以在 retrieve 时带 `delete_media_on_completion:true` | 必须在**本地转存校验成功之后**才调用；调用失败不影响用户，只记录日志并有限重试 |
| `download_url` | 预签名链接，不需要 auth；建议从同一出口 IP 获取；可 `DELETE` 撤销；反复获取会触发 429/410 | 只在 worker 内使用，不下发给前端，不写日志 |
| safe_mode | 视频 queue **不接受** `safe_mode` | 产品层面的“safe_mode 关”在视频侧无对应参数，只能靠选用 uncensored 模型 |
| 提示词优化 | queue schema 中**没有** `enhance_prompt` 一类字段 | 用户决定视频关闭“自动优化提示词”（PRD D9），不自研改写，也不发送这个字段 |
| 封面/缩略图 | 文档里没有 poster/thumbnail 字段 | 首帧封面要自己抽取 |

## 2. 六个目标模型（Venice id 与约束）

一个产品模型对应多个 Venice id：无图时走 t2v；有图时走 i2v（首帧）或 r2v（参考图）。

| 产品名（xlsx 标签） | 无图 | 单图 | 时长 | 分辨率 | 比例 | 音频可配置 | prompt 上限 | 图片限制 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Wan 3.0 Pro（默认） | `wan-3-0-pro-text-to-video` | 首帧 `wan-3-0-pro-image-to-video`（比例含 adaptive）；参考图 `wan-3-0-pro-reference-to-video` | 2/5/10/15/20/25/30s | 1080p/2k/4k | 16:9 9:16 1:1 4:3 3:4 | 是 | 20000 | 短边 ≥240 |
| Wan 3.0 Reference | 不支持 | `wan-3-0-reference-to-video`（必须带图） | 2/5/10/15/20/25/30s | 1080p/720p/480p | adaptive 16:9 9:16 1:1 4:3 3:4 | 是 | 20000 | 短边 ≥240 |
| MiniMax H3 Max | `minimax-h3-max-text-to-video` | 首帧 `minimax-h3-max-image-to-video`（无比例） | 5–15s（逐秒） | 480P/768P/1080P | 16:9 21:9 4:3 1:1 3:4 9:16 | **否**（固定有声） | 10000 | 未声明 |
| MiniMax H3 Max R2V | 不支持 | `minimax-h3-max-reference-to-video`（必须带图） | 5–15s | 480P/768P/1080P | adaptive + 6 种 | 否 | 10000 | 短边 ≥256，长宽比 0.4–2.5 |
| Seedance 1.5 Pro | `seedance-1-5-pro-text-to-video-basic` | 首帧 `seedance-1-5-pro-image-to-video-basic`（无比例） | 4–12s | 1080p/720p/480p | 21:9 16:9 4:3 1:1 3:4 9:16 | 是 | 3500 | 短边 ≥300，长宽比 0.4–2.5 |
| Seedance 2.0 R2V Enhanced | **当前目录中不存在该 id** | 最接近的是 `seedance-2-0-reference-to-video-basic`（"Seedance 2.0 R2V"） | 4–15s | 4k/1080p/720p/480p | 6 种 | 是 | 10000 | 短边 ≥300；可能遇到 409 needs_consent / 人脸媒体拒绝 |

~~阻塞项 B-MODEL-1~~（已关闭，PRD D8）：“Seedance 2.0 R2V Enhanced”在 2026-10-24 的公开目录里不存在。用户确认映射到 `seedance-2-0-reference-to-video-basic`，正常启用。种子中的标签通过 `seed_aliases` 指向这个模型，“用同款”可用。

## 3. 计价单位

quote 返回 USD；图片目录已有“USD 标准价 × 汇率 × 加价倍率 → 星尘”的运营公式（`ImagePlazaModelCatalogEditor`）。视频沿用同一个公式，参数为 duration × resolution × audio 组合。
