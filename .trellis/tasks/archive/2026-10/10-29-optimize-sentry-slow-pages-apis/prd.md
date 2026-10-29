# Sentry 慢页面与慢接口定向优化

## Goal

基于 `2026-10-29  3点前.md` 的固定 Sentry 时间窗和当前 `fix_request_speed` 工作树，降低 `/chat/[characterId]`、`/characters` 与 `/` 的可避免入场成本，减少离页后仍占用请求槽、重复查询与重复资源调度，并为 `/api/support/unread` 补齐可归因的代理阶段耗时；对消息发送与重生成以首字可见指标验收，不把完整 SSE 生命周期误当接口首响应。

## Requirements

- 基线时间窗固定为 2026-10-28 15:00 至 2026-10-29 15:00（Asia/Shanghai），报告只作为基线证据，不作为运行时配置。
- 保留当前工作树已有的 first-token race、fallback、可恢复投递、计费、额度、CAS 和终态语义；本任务不得重复修改 `packages/backend/src/features/generation/`、相关 migration 或 provider routing。
- React Query 的取消信号必须传递到本任务涉及的 characters、conversation detail/list、support 和同源 lobby 代理；离页后排队或在途读请求应尽快释放，不触发第二层重试。
- API Client 继续拥有 GET 传输层最多一次有限重试；React Query 不再叠加默认重试。调用方主动取消不重试，退避等待也必须可取消。
- `/characters` 必须复用父层已经取得的角色与会话数据；“接着聊”不得再自行订阅同一会话列表或为列表中已有角色补打一条详情请求。首屏图片不得在 `<img>` 已调度后再次追加同 URL preload。
- `/chat/[characterId]` 和 `/characters` 的默认关闭抽屉/详情面板必须按需加载；若第一轮拆分后 chat 路由独占 JS 仍高于 90 kB，再拆非首屏图片/语音操作，但不得延迟消息正文和输入框。
- `/` 保留 list/playback 并行、播放地址 critical、详情与 social 后置的当前语义；仅拆评论等未打开的可选 UI，不延后播放器、视频地址或首帧。
- `/api/support/unread` 不添加跨用户或长 TTL 结果缓存，不改变跨设备未读权威；客户端取消无用请求并取消强制 mount refetch，后端记录身份解析、客服上游和总耗时及状态，不记录用户 ID、正文、secret 或完整 URL。
- 所有触及的 Fastify route 保留附近 `@frontend-ready: true|false` 注释；错误按 `{ err }` 记录。
- 不新增 shared contract、数据库对象、migration 或依赖。若现有日志证明客服上游占主导，只记录独立仓库后续项，不在本仓库伪造本地“提速”。
- 保留用户已有和其他 Trellis 任务的变更，不自动提交、不 push；完成后按用户要求自动归档本任务。

## Acceptance Criteria

- [x] 当前工作树生产构建仍通过；`/chat/[characterId]` 路由独占 JS 从 101 kB 降至不高于 90 kB，或记录不能安全继续拆分的实测证据；`/characters` 与 `/` 首载 JS 不回退。
- [x] characters、conversation 与 support 的目标查询均向底层传递 `AbortSignal`；lobby 同源代理上游有明确超时并继承客户端取消。
- [x] API Client 与 React Query 的自动重试不叠加；GET 总尝试次数最多 2 次，POST 不自动重试，主动 abort 在排队、在途和退避阶段都不会再发请求。
- [x] `/characters` 首轮只发一条跨角色会话列表读取；“接着聊”复用父层角色摘要，不再额外请求角色详情；首屏图片没有重复 preload。
- [x] chat 会话正文、输入框、发送、停止、重生成保持原行为；角色详情和会话抽屉首次打开后可用，关闭状态不进入初始 route chunk。
- [x] 首页播放仍在目录加载后立即进入原播放链路；评论首次打开可用，未打开时评论表单/列表不进入首页初始 chunk。
- [x] support unread 在有效 30 秒缓存内重复挂载不强制刷新；前台恢复与轮询仍能更新；后端日志可区分 identity/upstream/total 且不含敏感字段。
- [x] 消息发送与重生成既有 first-token、fallback、cancel、billing、recoverable-delivery 测试全部通过；本任务不以 45.24s/32.28s 完整流 P95 作为首字验收。
- [x] 运行 frontend typecheck、相关 Vitest、lint、build，backend typecheck 与 support/conversation 相关测试，`git diff --check`，以及 `@roleplay`、`@chat`、`@drama`、`@profile` 现有 UI 分组。
- [x] 记录本地固定场景的请求计数、路由体积和剩余风险；真实 Telegram WebView、真实 provider、真实客服上游与发布后 Sentry P95 明确标注为本地验证边界。
- [x] 完成所有验收与任务记录后执行 `task.py archive --no-commit`，任务进入 `.trellis/tasks/archive/`。

## Notes

- 同一工作树已有 `10-28-sentry-cross-layer-performance-optimization`，本任务是其尚未完成的页面分波/按需加载和 support 归因的定向收口，不接管或归档该任务。
- 开始前已解决 `telemetry.ts`/`telemetry.test.ts` 合并冲突，并通过 backend typecheck、19 条相关测试与 `git diff --check`；该冲突修复是本任务继续执行的前置条件。
