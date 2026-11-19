# 修复视频生成并优化工作室体验

## Goal

修复 `feat_video_park` / Railway PR-566 中视频提交进入 worker 后被 Venice 以 HTTP 400 拒绝的问题，并缩短“点击生成 → 会话出现任务 → 上游完成后展示视频”的非模型计算等待。

## Requirements

- Venice `/video/queue` 请求必须符合当前官方契约；用户已被受理的生成不得因本次修复被自动重投。
- 保留现有 quote、预扣、幂等键、worker 租约、失败退款与 `failed_unknown` 语义；只允许向提交响应增加可选消息引用，不改变数据库结构。
- Venice 可选字段必须按文档语义发送：`audio=true` 使用上游默认值并省略，只有用户关闭音频时显式发送 `audio=false`。
- 上游非 2xx 必须保留低基数状态码、错误类型和校验字段摘要；不得记录 prompt、参考图 URL、密钥或完整响应正文。
- 提交成功响应若携带消息引用，Frontend 必须原子写入 conversation 与 attempt cache，让任务卡不等待额外 conversation GET 即出现；旧 Backend 响应仍降级为 invalidate/refetch。
- 新 attempt 创建后唤醒本实例 worker；进行中 provider poll 仍不小于 5 秒，但最大人工退避收敛到 10 秒，并优先使用 Venice 的预计/已执行时长。
- 视频链路只由非终态 attempt 按状态独立轮询，终态结果反向合并回 conversation cache；保留现有仅服务于图片任务的 conversation 轮询。
- 工作室读取 conversation 后不得为已终态的视频 attempt 逐条追加 GET；进行中的 attempt 继续按现有有限退避轮询并在回前台时同步。
- 长会话中 assistant 消息对应的最近用户提示词应线性计算，避免每条消息重复 `slice().reverse().find()`。
- 图片设置、视频模型和视频设置面板按需加载；主工作室首屏不等待这些低频交互代码。
- 视频模型选择 Sheet 增加明确的标题/说明/列表内边距、卡片间距、选中态、触屏与 focus-visible 状态，并保留安全区与独立滚动。
- 顶部标题与副标题超长时省略；返回、新建、历史按钮保持固定尺寸，不得被文字挤压或变形。

## Constraints

- Frontend 服务端数据继续只通过 `src/lib/api/image-plaza.ts` 的 React Query hooks 获取。
- 不新增 `any`、依赖、全局 CSS、数据库 migration 或新的客户端状态源；shared 仅做向后兼容的可选字段扩展。
- 不记录 prompt、参考图签名 URL、Venice key、完整上游响应或其他敏感内容。
- 本任务不改变模型目录、价格矩阵、扣费规则或 queue 自动重试策略。

## Acceptance Criteria

- [x] `queueVideo()` 将内部秒数转换为 Venice 所需的 `<n>s` 字符串，现有 upstream 回归测试明确锁定 `duration: "5s"`。
- [ ] PR-566 的 MiniMax H3 Max 10 秒、1080P、有声文生视频不再因向固定有声模型发送 `audio` 字段触发 `video_provider_http_400`；真实上游验证若受部署/额度限制需记录未覆盖风险。
- [x] `queueVideo()` 对 `audio=true` 省略字段、对 `audio=false` 显式发送字段；400 错误对象仅携带脱敏后的 provider 类型/消息/字段路径。
- [x] 提交成功后会话立即出现 user + assistant 任务记录，不再等待约 0.3–0.5 秒的 conversation refetch；没有新字段的旧响应仍能显示。
- [x] worker 在 API 受理后被主动唤醒；provider processing poll 间隔保持 5–10 秒，终态发现不再受原 20–60 秒退避拖延。
- [x] 视频状态只由 attempt 轮询；ready/failed 状态会合并进 conversation cache，页面离开/回前台仍可恢复，且不影响图片任务原有 conversation 轮询。
- [x] 视频和封面并行上传；queued/ready/failed 日志包含阶段耗时、模型 ID 和安全参数摘要，便于后续区分上游生成、转码、存储与 UI 延迟。
- [x] conversation 查询把响应内 video attempts 写入统一 query cache；终态 attempt 首屏不再产生逐条 GET，进行中 attempt 仍轮询。
- [x] 工作室最近用户提示词映射为 O(n) 预计算，展示与重生成行为不变。
- [x] 三个低频设置/模型组件按打开状态加载，首屏不提前挂载。
- [x] 模型 Sheet 在窄屏下具有一致外边距与卡片间距，关闭/模型项有可见 focus 状态，列表不遮挡底部安全区。
- [x] 超长标题/模型名不会压缩返回、新建、历史按钮，标题和副标题正确截断。
- [x] 通过 backend upstream test、frontend typecheck/lint/build、相关既有测试与 `@image` UI 场景；记录真实移动端/Telegram WebView 尚需人工确认的部分。

## Six-model capability audit addendum

- Audit all six enabled product models against Venice's current public video-model catalog, covering create-page generation, public-work reuse, image-to-video from an image card, and regeneration from a video card.
- Do not send provider fields that the selected provider mode does not advertise. In particular, image-to-video providers with an empty `aspect_ratios` capability must derive shape from the input image rather than receive `aspect_ratio`.
- Video-card regeneration must quote and submit the immutable parameters stored on the selected attempt, including model, input mode, duration, resolution, aspect ratio, audio, and reference artifact. It must not silently inherit the current composer settings.
- Keep quote validation, billing reservation, idempotency, reference authorization, worker leasing, and failure/refund behavior unchanged.
- Acceptance: MiniMax H3 Max and Seedance 1.5 Pro image-to-video requests omit `aspect_ratio`; text-to-video and reference-to-video requests still send it; regeneration uses the selected attempt snapshot; unavailable historical models fail clearly instead of falling back to another model.

## Notes

- Railway 证据：2026-10-30 06:08:39Z 创建 attempt 返回 202；06:08:40Z worker 记录 `video_plaza.submit_failed`，错误为 `video_provider_http_400`。
- 官方 Venice Queue 文档将 `duration` 定义为 `enum<string>`，示例与 Seedance R2V 均使用 `"5s"`。
- 提交 `9e42ad6b` 已于 2026-10-30 07:16Z 部署到 PR-566；07:23Z 的任务 `2e11be6a-…` 仍 400。公开 attempt 显示它是 MiniMax H3 Max、10s、1080P、audio=true、t2v，证明 duration 修复已生效但仍有第二个 payload 兼容问题。
- Venice 当前文档限定 `audio` 仅用于“支持音频生成和配置”的模型；公开 model catalog 显示 MiniMax H3 Max `audio_configurable=false`。省略 true 等价于上游默认 true，且避免固定有声模型拒绝该字段。
- PR-566 一次成功任务从 queued 到 ready 约 161.5 秒；模型生成占主体，但旧 worker/provider poll 最长 60 秒、Frontend attempt poll 最长 15 秒，会在模型完成后继续制造可见等待。
- 不自动发起新的会计费 Venice canary；部署后由用户显式生成验证。
