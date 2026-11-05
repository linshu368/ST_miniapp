# Frontend API、数据流与状态管理

## API 层地图

- `client.ts`：唯一通用 HTTP client，拼 `API_URL`、注入 Telegram `X-Init-Data`、解析 shared envelope/错误；只供 `lib/api` 使用。
- `query-client.ts`：QueryClient 单例/SSR 策略；query defaults 在此统一。
- `characters.ts`、`favorites.ts`：大厅角色/最新标记/收藏。
- `conversations.ts`：列表、详情、向前分页、创建/更新/删除、标题规则；`conversation-stream.ts`：发送/重生成 SSE parser。
- `text-postprocess.ts`：按消息实际 `postprocess_version` 批量读取不可变 artifact 快照；query key 按环境/版本集合隔离，单批最多 20 个去重版本。
- `generation-config.ts`、`models.ts`、`model-cache-policy.ts`：生成偏好、模型目录/选择和缓存 freshness。
- `voice.ts`：用户语音配置、会话音频、生成 mutation 和 audio map。
- `payment.ts`：套餐、下单、订单状态轮询、余额、流水、签到、订单 infinite query。
- `settings.ts`、`notifications.ts`、`support.ts`、`invite.ts`、`community.ts`：对应业务域。
- `growth.ts`：Provider 上报使用的纯请求函数；`use-refetch-on-foreground.ts`：可见性恢复。

业务组件只能调用 hooks；Provider 等非组件启动流程可调用明确设计的纯 API 函数。新增 query key 必须集中成 domain key factory；mutation 成功后精确 `setQueryData`/invalidate，不做全局无差别刷新。

## 数据流

`Telegram SDK init → getRawInitData → apiClient header → Backend auth → shared envelope → queryFn → React Query cache → page/component`。所有 URL/path/request/response 类型来自 shared。401/403、业务错误、网络错误和 abort 需保留可区分语义。

SSE：`page → streamConversationTurn(AbortSignal, callbacks) → fetch ReadableStream → shared event parser → 临时消息 state → done 后 cache 收敛`。parser 处理跨 chunk 行、未知/非法事件、HTTP JSON 错误、流中 error 和 EOF；不得在组件另写第二套 parser。

回复后处理：`ChatMessage/SSE start.postprocess_version → 批量 snapshot query → 边界 Zod 校验并冻结 artifact → ReplyRenderer`。缺版本、缺快照、协议不支持、source/artifact 错配或单行非法时只让对应消息退化为完整原始 Markdown，不得用 `latest/MAX(version)`、客户端 source 编译或其他版本替代。流式 delta 不触发 Worker；终态才运行 renderer。

## 四类状态的唯一归属

| 状态              | 工具/位置                             | 例子与禁忌                                                             |
| ----------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| 服务器状态        | React Query                           | 角色、会话、钱包、订单、通知；不得复制到长期 Zustand                   |
| 跨组件客户端状态  | Zustand                               | `font-scale-store`、`ui-store`、`user-profile-store`；只持 UI/展示镜像 |
| 页面/组件临时状态 | `useState/useReducer/ref`             | Sheet、选项、composer、当前流 delta；卸载后无需共享                    |
| URL/导航状态      | pathname/search params/dynamic params | character/session 回跳、payment returned、tab（需分享/恢复时）         |

`user-profile-store` 合并 Telegram/localStorage/server settings，必须定义优先级；`font-scale-store` 只持显示倍率；`ui-store` 只放跨组件 UI。hydrate 仅在客户端运行，localStorage 异常应降级。不要让 useEffect 在两份状态间无限同步。

## 缓存、并发与恢复

- query 配置合理 `staleTime`、enabled、refetch；轮询仅对 pending/需实时状态开启，后台/终态停止。
- mutation 防双击；乐观更新必须有 snapshot/rollback，金额、订单、奖励等关键数据优先服务端确认。
- 页面切换/unmount 中止可取消读取；写入是否中止取决于后端幂等性，不能因浏览器 abort 假设服务端回滚。
- 网络恢复/前台恢复只刷新需要的 key，限制请求风暴。错误界面给出安全重试；不可重试的 validation/auth 不自动循环。
- 首字交付回报兼容旧 Telegram WebView：每次用 `AbortController` + 可清理的计时器约束排队、响应头与响应体读取，保持3秒/最多3次的既有预算。不可直接依赖 `AbortSignal.timeout`（Chrome90/92不存在），也不可仅以通用client的响应头超时替代整个回报尝试的期限。成功确认即停止，不新增补报扫描或历史重算。
- mock 必须按模块显式启用，返回 shared shape，并在 production build 中默认关闭。

## Telegram 与敏感边界

`lib/telegram/init.ts` 初始化 SDK；`auth.ts` 提供 raw initData；`user.ts` 解析最小用户字段；`launch-url.ts` 尽早清理 URL 敏感参数；`hooks.ts/index.ts` 封装运行环境。禁止日志/Sentry/replay 收集完整 initData、支付参数和消息正文。

禁止日志、Sentry 事件、URL query 和应用错误上报收集完整 initData、支付参数、`pay_url`、token/secret 和消息正文。`sanitizeTelemetry` 只清理已知敏感键，不能替代 Session Replay 的 DOM/输入屏蔽。

### Design Decision: Session Replay 聊天正文例外

**Decision**: 2026-09-15 隐私责任人批准受控例外：用户输入和模型回复可以出现在 Sentry Session Replay **画面**中（`maskAllText: false`）。例外不授权把正文复制到事件、日志或错误上报。支付密码/账号/验证码等输入仍须 browser-side 屏蔽；完整 initData 与 `pay_url` 不得出现在录制 URL 中。2026-11-04 起项目只保留 Sentry Replay（PostHog 录屏与事件已移除）。

| 通道                             | 完整 initData / token / secret | `pay_url` 与支付表单 | 聊天正文       |
| -------------------------------- | ------------------------------ | -------------------- | -------------- |
| 应用日志、Sentry 事件、URL query | 禁止                           | 禁止                 | 禁止           |
| Sentry Session Replay 画面       | 禁止                           | 禁止                 | 允许（已批准） |

## Scenario: 显式取消文字回复与重新生成

取消经 `lib/api/conversations.ts` 的 React Query mutation 调用服务端；浏览器 AbortController 只负责停止本地读流。生成入口同时检查本地请求身份、取消待确认与服务端 streaming，后者不能只禁用发送却隐藏取消按钮。

start 尚未到达时，按本次 request_id UUID 及预期 turn_index/revision 定位消息再提交 assistant_message_id；禁止盲目取消最后一条或另一设备的同轮请求；没有匹配关联 ID 的旧行不能作为本次未 start 请求的发现结果。取消暂未确认保留占用与重试，服务端确认终态后保留用户输入和已收到正文，最新失败回复下显示“重新生成”，复用最后一轮 regeneration。

所有 SSE 回调与异步刷新必须检查请求/会话身份。详情轮询可能先看到当前 revision，临时消息合并须去重并以已持久化终态为准。SSE、取消请求、详情刷新与额度刷新都有有限等待，不能因后台请求卡住永久保留 generating。实现断网/超时错误时先回查服务端，不把已经持久化的原输入再次恢复并重复发送。

## Scenario: 首 token 体验预算（2026-10-26）

### 1. Scope / Trigger

从接受发送/重生成动作起，以同一单调时钟测量正文或开启的思考首次可见。默认10秒总硬限；网络接收和服务端写出不是显示。

### 2. Signatures

`FirstTokenObservation.displayed(identity,at)`、`deadlineFailed(reason)`、`observeFirstVisibleToken(node,callback)`；既有报告接口新增 `measurement_method=visible_dom_after_frame_v2` 与可选 `wait_finished_ms`。

### 3. Contracts

v2扫描text node全部非空白片段，检查页面前台、祖先裁剪、样式和两帧绘制机会。报告身份绑定request/session/revision，结束时固定wait_finished_ms，身份晚到不改时长。后台/缺报单列，不将未显示时长补0。不是物理屏幕像素确认。

### 4. Validation & Error Matrix

提前首发/兜底失败为not_observed加primary_timeout/fallback_timeout；达到总限为timed_out。截止走现有安全取消，待确认仍占用，已完成CAS不覆盖；迟到delta不继续写临时回复。普通上游错误独立上报，不混成时间截断。

### 5. Good/Base/Bad Cases

Good：长段文字首字符滚出但尾部可见仍确认首字。Base：可见思考先于正文即结束计时。Bad：纯空白行/等待标题算字，或把失败等候当作成功首字分布。

### 6. Tests Required

既有hook/observation回归覆盖10秒安全取消、早期失败真实时长、迟到身份与已显示不被覆盖；真实浏览器检查长文本/思考滚动、空白、隐藏、透明正负对照。真机WebView与真实供应商留待TEST/生产验收。

### 7. Wrong vs Correct

Wrong：6秒只记SLA但继续无界等字，或者以供应商latency画体验图。Correct：前台10秒截止有重试提示；看板主图显示完全无字时间截断率与客户端首token分布，同时展示缺报覆盖。

主动停止与自动截止（2026-10-26）：取消mutation显式携带reason=user_stop或first_token_timeout，不能共用没有原因的取消。只刷新原钱包与权益缓存，不额外提示扣费；服务端确认终态后清本地占位。旧调用方省略字段保持兼容；当前前端手动和自动测试分别验证原因。

## 可恢复交付协议 v3（2026-10-27）

本节取代旧版“当前未可见→自动取消/免单”的运行规则。后端4秒首发、2秒兜底、10秒总首字预算仍由正式配置决定；模型在预算内选中有效首字后立即放行，意图/身份持久化与传输并行，结算前必须确认。断连写入返回false，不冒充客户端已收到；断连不终止生成。

客户端v3记录真实接收/显示时间，收到后视口未显示不触发取消；hidden/page_left是观测中断，返回实际显示可更新记录且保留后台标记。前台超过预算未收到的事实锁存，不因后续可恢复而抹除。新策略拒绝旧页面的first_token_timeout取消指令；真实截止由生成服务控制，明确user_stop仍走原价一次结算。

回复恢复复用有权限的会话详情与原活动轮询。活动快照最多128轮、125秒，每轮正文256Ki字符/公开思考64Ki字符，按user/session/revision隔离；一次first_token_preview检查点最多2048字符，最终正文仍由chat_history持久化。跨实例/进程重启读取检查点和最终结果，不宣称进程内快照持久。公开思考不写入正文或后续prompt。

recoverable_delivery仅新Backend显式启用；旧请求/终结账单不回填、不追扣。离页/后台已完整保存且可取回的正常回复不免单；真实系统截止/前台无接收超时免费，主动停止原报价原权益一次。缺回报继续pending，预算+15秒仍缺报按保守免单处理，避免服务端完成先扣费而客户端随后报告失败。只有思考无完整正文不自动收费。内部billing gate复用visible返回值表示已满足该轮交付策略，并非声称用户当时正在看。

唯一新增迁移20261027_recoverable_chat_delivery.sql：experience拥有策略/首字检查点，billing资格函数读取事实；analytics只追加无正文的策略/时刻/失败锁存字段。无新cron、逐token数据库写、业务回填或公开权限。先TEST、后生产迁移、后Backend/Frontend。回退保留新增对象和终账，必要时forward-fix。

验证：本任务release-review记录自动化、真实PG、TEST流/浏览器和生产版本证据；测试通过不等于线上1%目标已达成。看板v3区分前台等待超时与系统无首字截断，显示分布只用浏览器业务侧实际时长，后台/缺报不填0。
