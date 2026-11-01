# Design

## 1. Current flow and root cause

```text
Studio -> video quote -> POST video-attempts (202 + reserve)
       -> worker claim -> queueVideo -> Venice /video/queue
       -> poll/retrieve -> storage/publish -> Studio polling
```

第一轮已把内部 `duration_s: number` 在 adapter 边界转换为 Venice 所需的 `"<n>s"`。该提交已真实部署，但 MiniMax H3 Max 10 秒 t2v 仍返回 400。公开 model catalog 显示该模型固定有声（`audio_configurable=false`），而 Venice Queue 文档说明 `audio` 只用于可配置音频模型；当前 adapter 无条件发送 `audio: true`，是剩余的模型级不兼容字段。

性能链路的可控等待为：提交 API 多次串行 Supabase 往返（线上约 1.1s）→ worker 最多等待 3s 周期才 claim → provider processing 按 5/10/20/40/60s 退避 → Frontend attempt 最长退避到 15s 才发现终态。现有 conversation 2s 轮询只覆盖图片 attempt，不参与视频链路，必须保留。上游成功样本 queued→ready 约 161.5s，不能缩短模型计算，但可以消除上述排队和终态发现延迟。

## 2. Reuse research

| Existing capability                                              | Decision                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `video-upstream.ts` provider adapter                             | 扩展：在唯一 Venice queue 边界格式化 duration；不把 provider 格式扩散到 shared/DB。 |
| `video-upstream.test.ts`                                         | 复用并补强已有“documented queue fields”测试，不新建测试文件。                       |
| Venice Queue / public model catalog                              | 复用公开能力证据：true 使用默认音频，false 才显式传；retrieve 时长用于 poll 建议。  |
| `video-job.ts` + 现有 worker lease                               | 扩展：保留 claim/fencing，只增加进程内 wake 与有界 5–10s poll，不改计费写路径。     |
| `VideoPlazaRepository`                                           | 扩展：返回已创建消息引用、并行 attempt/artifact 读取；不新建 RPC 或 migration。     |
| `useImagePlazaConversationQuery` + `imagePlazaKeys.videoAttempt` | 扩展：conversation 成功响应同步写入同一 attempt cache，保持单一服务器状态源。       |
| `useVideoPlazaAttemptQuery`                                      | 复用：终态缓存设为永久 fresh；非终态仍沿用退避轮询/前台恢复。                       |
| `SubmitVideoPlazaAttemptData`                                    | 向后兼容扩展可选 `message_refs`；新前端即时合并，旧后端响应走原 invalidate。        |
| Next `dynamic()` 既有聊天页模式                                  | 复用：低频 Sheet/Dialog 按打开状态加载，不新增 lazy-loading 框架。                  |
| `VideoModelSheet` + 通用 `Sheet` primitive                       | 原位调整 Tailwind；不改 primitive、不新增 CSS。                                     |
| `ImagePlazaHistorySheet`                                         | 保留同步入口，避免历史按钮晚出现造成 header CLS。                                   |
| shared contracts / DB functions                                  | 不改；外部 provider wire format 不属于公开客户端契约。                              |

已检索：studio 页面、image-plaza hooks/query keys、video model/settings/history、video upstream/job/repository、shared video contracts、UI tests、原视频规划 research/design。

## 3. Minimal sufficient changes

1. `queueVideo()` 保留字符串 duration；true 音频依赖默认值、false 显式发送；非 2xx 只提取脱敏摘要。
2. retrieve 解析 `average_execution_time` / `execution_duration`，由纯函数给出 5–10 秒下一次 poll；fallback 同样封顶 10 秒。
3. 提交完成调用进程内 worker wake；worker 忙时只补跑一次，不能并行突破现有 `running`/DB lease。
4. submit 响应可选返回两条 message refs；Frontend 原子 append 并写 attempt cache。视频 attempt 更新反向合并 conversation；图片任务的原有 conversation 轮询保持不变。
5. repository 在原有顺序消息写入上返回服务端 ID/时间，并行读取 attempt/artifact；视频与 poster 并发上传，并等待两者均结束后再决定清理，避免失败竞态留下孤儿对象。
6. 保留已完成的 studio O(n) 映射、dynamic 面板、Sheet 与 header 优化。

拒绝的过度设计：不新增队列服务、SSE/WebSocket、数据库通知、通用 provider capability framework、批量 attempt 接口或迁移。模型生成仍为异步 worker；即时展示只复用提交响应与 React Query cache。

## 4. Reliability design

| Concern                    | Decision                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Timeout                    | 保留 queue/retrieve/download/complete 明确 timeout；UI API 仍有 10–15 秒上限。                                       |
| Retry                      | queue 是计费写入，仍不在调用内自动重试；retrieve/download/complete 的既有限次重试不变。                              |
| Idempotency                | 客户端/DB `idempotency_key` 与 worker lease/fencing 不变；不自动重投本次已失败 attempt。                             |
| Concurrency                | worker wake 忙时只设置一次补跑标记；DB lease/fencing 仍是跨副本权威。cache 按 message/attempt id 去重。              |
| Transaction / compensation | reserve/publish/refund RPC 不改；明确 400 仍走可退款失败。                                                           |
| Degradation                | 旧 Backend 无 `message_refs` 时回退 conversation refetch；retrieve 缺时长时走 5–10 秒 fallback。                     |
| Rate / capacity            | 视频每个非终态 attempt 按状态 2–5 秒读 API，provider poll 5–10 秒且每用户最多 2 个 active；图片轮询行为不变。        |
| Observability              | queued/ready/failed 记录总耗时和阶段耗时；上游仅记录 status/type/脱敏 message/字段路径，不记录 body、prompt 或 URL。 |

## 5. Evolution and recovery

- 兼容：内部 number、DB 列和 Admin 目录不变；`message_refs` 为可选 additive 字段，旧前后端组合均可运行。
- 发布：Backend 修复必须先于真实重试；Frontend 可同一分支随后发布。无 migration。
- 旧数据：既有 failed attempt 保留失败与退款事实，不自动重放；用户可显式“按当前设置再生成”。
- 停止条件：upstream test 不符、Frontend query 行为回归、build/typecheck 失败或 UI 现有 `@image` 场景失败时不交付。
- 回滚：单提交可回滚；无 migration。若 provider 再变，先依赖安全错误摘要 forward-fix adapter，停止条件为 400 持续或 poll 频率异常。

## 6. Verification design

- Shared：contract test/typecheck，验证 `message_refs` 可省略且有值时严格校验。
- Backend：现有 `video-upstream.test.ts` 断言 true 省略/false 显式、错误摘要、retrieve timing 与 5–10 秒调度；运行相关测试与 typecheck。
- Frontend：既有 `media-cache.test.ts` 覆盖即时 append、去重、旧响应 fallback、终态反向合并；typecheck、lint、build 与全量既有 tests。
- 静态检查：`git diff --check`、Web Interface Guidelines 审查（focus、长文本、safe area、overscroll、touch target）。
- 人工场景：320/375px 长标题；模型名/描述超长；终态与进行中 video attempts 混合；PR-566 真实 5s Seedance R2V/Wan canary（仅用户显式发起，避免自动计费）。

## 7. Six-model capability and flow audit

The live PR-566 public catalog contains six enabled products. Their configured provider IDs all exist in the current Venice catalog. Configured duration, resolution, text/reference aspect ratios, and audio behavior are valid subsets of provider capabilities.

Confirmed differences:

1. `minimax-h3-max-image-to-video` and `seedance-1-5-pro-image-to-video-basic` advertise no `aspect_ratios`. The shared product selector still has ratios for text generation, so the provider adapter must omit `aspect_ratio` for every `i2v` request. Wan image-to-video accepts the field, but omission is safe and consistently lets the input image determine output shape.
2. Seedance 2.0 R2V advertises input-image ratio limits 0.4 through 2.5 while the live product catalog exposes only minimum short side 300. Images produced by the current image plaza ratios fall inside that range, so the image-card flow is valid; arbitrary future uploads still need UI validation before submission.
3. Wan 3.0 Pro has an R2V provider ID in Admin defaults, but `optional_first_frame` always selects I2V. This is redundant configuration, not a runtime failure.
4. Video-card regeneration currently passes only the prompt and therefore uses the current composer model/settings/reference. The attempt already stores the authoritative immutable snapshot, so regeneration must build the quote and submission from `attempt.params`.

Reuse research: reuse `VideoPlazaAttempt.params`, `VideoPlazaQuoteRequest`, the existing quote mutation/cache, provider adapter, and reference authorization. Do not add a provider-capability service, schema, migration, dependency, or second state source.

Reliability: queue remains a non-retried billable write; a new idempotency key is generated only after a successful quote; historical reference authorization is still checked server-side; a removed model fails before billing. No automatic paid canary is run. Rollback is a single-code-change revert with no data migration. Verification covers I2V omission, T2V/R2V preservation, original-attempt regeneration, typecheck, tests, build, and the existing `@image` scenario.

## 8. Local acceptance reminder

这是跨 worker、API cache 与移动端工作室的完整流程修复。应继续复用 `packages/ui-tests` 的 `@image` 场景，后续建议补充“长标题 + 多个终态视频 + 模型 Sheet 窄屏”fixture；本轮优先扩展现有场景/fixture，不创建一次性浏览器脚本。
