# Design

## 1. Current flow and root cause

```text
Studio -> video quote -> POST video-attempts (202 + reserve)
       -> worker claim -> queueVideo -> Venice /video/queue
       -> poll/retrieve -> storage/publish -> Studio polling
```

PR-566 的 route、鉴权、quote 与 attempt 创建均成功。失败发生在 worker：`video-upstream.ts` 直接把内部 `duration_s: number` 作为 JSON number 发送。Venice 当前 Queue 契约要求 `duration` 是带单位的字符串（如 `"5s"`），因此返回 400。内部 shared/DB 继续保留 number，provider adapter 在边界转换即可。

## 2. Reuse research

| Existing capability                                              | Decision                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `video-upstream.ts` provider adapter                             | 扩展：在唯一 Venice queue 边界格式化 duration；不把 provider 格式扩散到 shared/DB。 |
| `video-upstream.test.ts`                                         | 复用并补强已有“documented queue fields”测试，不新建测试文件。                       |
| `useImagePlazaConversationQuery` + `imagePlazaKeys.videoAttempt` | 扩展：conversation 成功响应同步写入同一 attempt cache，保持单一服务器状态源。       |
| `useVideoPlazaAttemptQuery`                                      | 复用：终态缓存设为永久 fresh；非终态仍沿用退避轮询/前台恢复。                       |
| Next `dynamic()` 既有聊天页模式                                  | 复用：低频 Sheet/Dialog 按打开状态加载，不新增 lazy-loading 框架。                  |
| `VideoModelSheet` + 通用 `Sheet` primitive                       | 原位调整 Tailwind；不改 primitive、不新增 CSS。                                     |
| `ImagePlazaHistorySheet`                                         | 保留同步入口，避免历史按钮晚出现造成 header CLS。                                   |
| shared contracts / DB functions                                  | 不改；外部 provider wire format 不属于公开客户端契约。                              |

已检索：studio 页面、image-plaza hooks/query keys、video model/settings/history、video upstream/job/repository、shared video contracts、UI tests、原视频规划 research/design。

## 3. Minimal sufficient changes

1. `queueVideo()` 把 `duration` 设为 `${input.duration}s`；测试断言完整关键 payload。
2. conversation query 遍历响应中的 `video_attempt`，用现有 key 写入 `{ attempt }`；attempt query 根据缓存状态决定 staleTime。
3. studio 用一次 `useMemo` 线性构建 assistant message -> 最近 user prompt 映射。
4. 三个低频面板使用 `next/dynamic`，仅在 open 时挂载。
5. 原位调整模型 Sheet 和 header flex 约束。

拒绝的过度设计：不引入虚拟列表、全局 preload 管理器、新 store、provider capability framework、批量 attempt 新接口或新的通用 Dialog 体系。

## 4. Reliability design

| Concern                    | Decision                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| Timeout                    | 保留 queue 明确 timeout；本次只修 wire format。                                                  |
| Retry                      | queue 是计费写入，仍不在调用内自动重试；retrieve/download/complete 的既有限次重试不变。          |
| Idempotency                | 客户端/DB `idempotency_key` 与 worker lease/fencing 不变；不自动重投本次已失败 attempt。         |
| Concurrency                | query cache 写入按 attempt id 隔离；TanStack Query 负责订阅，避免另建镜像状态。                  |
| Transaction / compensation | reserve/publish/refund RPC 不改；明确 400 仍走可退款失败。                                       |
| Degradation                | 动态面板 chunk 未就绪时主页面仍可读写；终态 attempt 以 conversation 数据直接展示。               |
| Rate / capacity            | 消除终态 attempt N+1 GET，进行中轮询频率保持原有 3s 指数退避到 15s。                             |
| Observability              | 继续使用 `video_plaza.submit_failed`、attemptId 与低基数错误码；不记录上游 body、prompt 或 URL。 |

## 5. Evolution and recovery

- 兼容：内部 number、shared DTO、DB 列和 Admin 目录完全不变；仅 Venice adapter wire format改变。
- 发布：Backend 修复必须先于真实重试；Frontend 可同一分支随后发布。无 migration。
- 旧数据：既有 failed attempt 保留失败与退款事实，不自动重放；用户可显式“按当前设置再生成”。
- 停止条件：upstream test 不符、Frontend query 行为回归、build/typecheck 失败或 UI 现有 `@image` 场景失败时不交付。
- 回滚：单提交可回滚代码；若新 provider 契约再次变化，forward-fix 仅限 adapter，不迁移 shared/DB。

## 6. Verification design

- Backend：现有 `video-upstream.test.ts` 断言字符串 duration、reference 字段和无多余字段；运行相关测试与 backend typecheck。
- Frontend：typecheck、lint、build；既有 frontend tests；`pnpm test:ui --grep @image` 覆盖工作室打开模型 Sheet 与生成路径。
- 静态检查：`git diff --check`、Web Interface Guidelines 审查（focus、长文本、safe area、overscroll、touch target）。
- 人工场景：320/375px 长标题；模型名/描述超长；终态与进行中 video attempts 混合；PR-566 真实 5s Seedance R2V/Wan canary（仅用户显式发起，避免自动计费）。

## 7. Local acceptance reminder

这是跨 worker、API cache 与移动端工作室的完整流程修复。应继续复用 `packages/ui-tests` 的 `@image` 场景，后续建议补充“长标题 + 多个终态视频 + 模型 Sheet 窄屏”fixture；本轮优先扩展现有场景/fixture，不创建一次性浏览器脚本。
