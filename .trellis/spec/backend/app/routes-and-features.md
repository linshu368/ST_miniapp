# Backend 路由、功能域与调用链

## 路由插件清单

| 文件                                       | 功能与依赖                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `characters.ts` / `favorites.ts`           | 角色列表详情、大厅排序/最新标记；收藏列表/切换                                 |
| `conversations.ts`                         | 会话 CRUD、消息 SSE、重生成、generation config；conversation/engine/generation |
| `voice.ts` / `models.ts`                   | 语音配置、会话音频、语音生成；模型档位/目录/选择                               |
| `settings.ts` / `wallet.ts`                | 用户昵称头像偏好；余额、流水、签到                                             |
| `payment.ts` / `wishes.ts`                 | 套餐、下单、订单查询/回调；许愿状态、创建、完成                                |
| `notifications.ts` / `support.ts`          | 消息中心；MiniApp 客服会话、消息、已读/未读                                    |
| `cs-platform.ts`                           | Telegram 回访、画像、群发、导出等内部 API                                      |
| `invite.ts` / `growth.ts` / `community.ts` | 邀请绑定/统计；渠道归因；官方群验证与奖励                                      |
| `bot.ts`                                   | Telegram webhook、start 与回复回流                                             |
| `admin-supabase-proxy.ts`                  | Admin 受控代理；会话验证、白名单、审计，禁止演变为通用 SQL 代理                |

每条注册必须有 `@frontend-ready`。路径、method、request/response/error/SSE 以 `shared/src/api/*` 为唯一对外定义。route 只做鉴权、校验、调用编排、HTTP 映射和摘要日志。

## 核心数据流

### Telegram REST

`X-Init-Data → requireTelegramAuth → shared request 校验 → feature/repository → Prisma/Supabase/RPC → shared envelope → response`。不得记录完整 initData；ownership 必须在读写层校验，不能信任客户端 user id。

### 对话 SSE

1. 鉴权并校验 session ownership；并行解析模型、角色、偏好、昵称、平台规则和窗口配置。
2. 原子 RPC 在会话锁内分配 `turn_index`/revision、执行上下文泄洪并写 `streaming` 行。
3. history 展开窗口，engine 组 prompt 并保存快照。
4. generation 做免费额度、定价、余额预检和上游请求。
5. 上游确认 2xx 后才提交 SSE headers，发送 `start → delta* → done`；此前错误保持 HTTP JSON，流中错误发 `error`。
6. 客户端断开后按既有策略 drain，终态同步写入，usage/扣费由即时记录和 sync job 收敛。

不得提前发 SSE 首字节；并发、重复 regenerate、余额不足和上游失败必须有确定状态。事件字段改动先改 shared，并测试前后端 parser。

### 支付、语音与增长

- 支付：`route → RechargeUseCase → repository + gateway`；回调/主动查询统一进入 `PaymentSettlement`。业务/provider transaction id 是幂等键；状态迁移和钱包入账必须原子或可安全重放。
- 语音：`route → ownership → draft/text/prompt → DeepSeek（按需）→ MiniMax → Storage → audio repository`。上游有超时；同消息并发生成不得产生不受控重复写入。
- 邀请/归因/社群：入口码先校验，绑定和奖励依赖原子 RPC；Telegram webhook 校验 secret，处理重复 update，区分业务终态与可重试网络失败。

## 状态、错误与日志

- 成功/失败使用 shared envelope 或约定 SSE；domain error 映射稳定 HTTP code，未知错误记录 `{ err }` 后返回无敏感细节 5xx。
- 404/409/402/422 在写响应前确定；外部 429/5xx 仅在幂等且总时限允许时重试。
- route 日志包含允许的请求摘要、结果摘要、耗时和链路标识；禁止消息正文、token、支付密钥、完整 initData、大响应。
