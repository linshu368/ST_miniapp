# Frontend API、数据流与状态管理

## API 层地图

- `client.ts`：唯一通用 HTTP client，拼 `API_URL`、注入 Telegram `X-Init-Data`、解析 shared envelope/错误；只供 `lib/api` 使用。
- `query-client.ts`：QueryClient 单例/SSR 策略；query defaults 在此统一。
- `characters.ts`、`favorites.ts`：大厅角色/最新标记/收藏。
- `conversations.ts`：列表、详情、向前分页、创建/更新/删除、标题规则；`conversation-stream.ts`：发送/重生成 SSE parser。
- `generation-config.ts`、`models.ts`、`model-cache-policy.ts`：生成偏好、模型目录/选择和缓存 freshness。
- `voice.ts`：用户语音配置、会话音频、生成 mutation 和 audio map。
- `payment.ts`：套餐、下单、订单状态轮询、余额、流水、签到、订单 infinite query。
- `settings.ts`、`notifications.ts`、`support.ts`、`wishes.ts`、`invite.ts`、`community.ts`：对应业务域。
- `growth.ts`：Provider 上报使用的纯请求函数；`health.ts`：健康查询；`use-refetch-on-foreground.ts`：可见性恢复；`mock-registry*`：显式开发 mock，不得生产误启。

业务组件只能调用 hooks；Provider 等非组件启动流程可调用明确设计的纯 API 函数。新增 query key 必须集中成 domain key factory；mutation 成功后精确 `setQueryData`/invalidate，不做全局无差别刷新。

## 数据流

`Telegram SDK init → getRawInitData → apiClient header → Backend auth → shared envelope → queryFn → React Query cache → page/component`。所有 URL/path/request/response 类型来自 shared。401/403、业务错误、网络错误和 abort 需保留可区分语义。

SSE：`page → streamConversationTurn(AbortSignal, callbacks) → fetch ReadableStream → shared event parser → 临时消息 state → done 后 cache 收敛`。parser 处理跨 chunk 行、未知/非法事件、HTTP JSON 错误、流中 error 和 EOF；不得在组件另写第二套 parser。

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
- mock 必须按模块显式启用，返回 shared shape，并在 production build 中默认关闭。

## Telegram 与敏感边界

`lib/telegram/init.ts` 初始化 SDK；`auth.ts` 提供 raw initData；`user.ts` 解析最小用户字段；`launch-url.ts` 尽早清理 URL 敏感参数；`hooks.ts/index.ts` 封装运行环境。禁止日志/Sentry/replay 收集完整 initData、支付参数和消息正文。
