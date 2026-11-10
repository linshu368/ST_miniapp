# Backend 路由、功能域与调用链

## 路由插件清单

| 文件                                       | 功能与依赖                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `characters.ts` / `favorites.ts`           | 角色列表详情、大厅排序/最新标记；收藏列表/切换                                                   |
| `conversations.ts`                         | 会话 CRUD、消息 SSE、重生成、generation config；conversation/engine/generation                   |
| `voice.ts` / `models.ts`                   | 语音配置、会话音频、语音生成；模型档位/目录/选择                                                 |
| `settings.ts` / `wallet.ts`                | 用户昵称头像偏好；余额、流水、签到                                                               |
| `payment.ts` / `vip.ts`                    | 套餐、下单、订单查询/回调；VIP 状态与入口角标                                                    |
| `telemetry.ts`                             | 短剧播放耗时/诊断报告接收；负责鉴权、校验和日志摘要，不承载 replay context                       |
| `notifications.ts` / `support.ts`          | 消息列表、单条详情和按 id 已读；MiniApp 客服会话、消息、已读/未读                                |
| `invite.ts` / `growth.ts` / `community.ts` | 邀请绑定/统计；渠道归因；官方群验证与奖励                                                        |
| `bot.ts`                                   | Telegram webhook、start 与回复回流                                                               |
| `admin-supabase-proxy.ts`                  | Admin 受控代理；会话验证、白名单、审计，禁止演变为通用 SQL 代理                                  |
| `text-postprocess.ts`                      | Admin 草稿/发布/回滚/request lookup 与 MiniApp 版本批次读取；text-postprocess service/repository |

每条注册必须有 `@frontend-ready`。路径、method、request/response/error/SSE 以 `shared/src/api/*` 为唯一对外定义。route 只做鉴权、校验、调用编排、HTTP 映射和摘要日志。

## 核心数据流

### Telegram REST

`X-Init-Data → requireTelegramAuth → shared request 校验 → feature/repository → Prisma/Supabase/RPC → shared envelope → response`。不得记录完整 initData；ownership 必须在读写层校验，不能信任客户端 user id。

### 对话 SSE

1. 鉴权并校验 session ownership；并行解析模型、角色、偏好、昵称、平台规则和记忆配置；最新会话记忆单独并行读取（用到时最多再等 50ms，失败不注入）。
2. 原子 RPC 在会话锁内分配 `turn_index`/revision 并写 `streaming` 行（不推进窗口）。
3. 按正文字数水位与记忆覆盖决定窗口（先压缩后截断，写入不等待），engine 组 prompt（记忆作为紧跟角色卡的独立 system 消息）并保存快照。
4. generation 做免费额度、定价、余额预检和上游请求。
5. 上游确认 2xx 后才提交 SSE headers，发送 `start → delta* → done`；此前错误保持 HTTP JSON，流中错误发 `error`。
6. 客户端断开后按既有策略 drain，终态同步写入，usage/扣费由即时记录和 sync job 收敛。

不得提前发 SSE 首字节；并发、重复 regenerate、余额不足和上游失败必须有确定状态。事件字段改动先改 shared，并测试前后端 parser。

开轮必须调用 `experience.start_chat_history_*_with_current_postprocess`，由数据库事务读取当前正式指针、校验不可变 artifact 快照并返回非空 `postprocess_version`。新 RPC 缺失、配置非法或快照不可用时在 LLM/计费/SSE 前失败且不留 history 半写；不得回退旧显式 wrapper 或进程缓存。

### 回复后处理发布与读取

Admin 写路径为 `route → text-postprocess service → 可终止编译 Worker → repository/RPC`。保存草稿不编译发布；发布和回滚在进入事务前编译并由 shared 再校验 artifact，RPC 内以草稿/当前版本 CAS 和 `request_id` 原子写 source、artifact、新版本、runtime 指针、release/audit。结果未知只允许 request lookup，不自动重复 mutation。

MiniApp 读路径按最多 20 个去重版本批量读取不可变快照。每行独立 runtime 校验；坏行返回 unavailable，不泄露 source、SQL 或内部错误，也不以最新版本替代。

### 支付、语音与增长

- 支付：`route → RechargeUseCase → repository + gateway`；回调/主动查询统一进入 `PaymentSettlement`。VIP 与星尘订单都在这里履约，商品条款取下单时快照。业务/provider transaction id 是幂等键；状态迁移和钱包入账必须原子或可安全重放。
- 语音：`route → ownership → draft/text/prompt → DeepSeek（按需）→ MiniMax → Storage → audio repository`。上游有超时；同消息并发生成不得产生不受控重复写入。
- 邀请/归因/社群：入口码先校验，绑定和奖励依赖原子 RPC；Telegram webhook 校验 secret，处理重复 update，区分业务终态与可重试网络失败。

## 状态、错误与日志

- 成功/失败使用 shared envelope 或约定 SSE；domain error 映射稳定 HTTP code，未知错误记录 `{ err }` 后返回无敏感细节 5xx。
- 404/409/402/422 在写响应前确定；外部 429/5xx 仅在幂等且总时限允许时重试。
- route 日志包含允许的请求摘要、结果摘要、耗时和链路标识；禁止消息正文、token、支付密钥、完整 initData、大响应。

## Scenario: 首 token 预算内的读取依赖（2026-11-02 候选）

### 1. Scope / Trigger

6秒无字超时必须检查整个调用前依赖图，不能只计算合并了几次写入。配置与报价只读准备不应串在开轮、上下文和prompt保存之后。

### 2. Signatures

`prepareGeneration({model: ResolvedModel | Promise<ResolvedModel>, characterId, useFallback}) -> Promise<GenerationPreparation>`；`GenerationRequest.preparation`可选，缺省消费者沿用同一prepare实现。

### 3. Contracts

只提前定价/VIP策略/路由/创作者身份/额度上限读取，绑定本轮模型和角色并在execute核验；不提前预留、扣款或发供应商请求。stale recovery可与独立读取并行，但开轮必须等恢复完成。初始charge身份、额度决策、余额预检、最终prompt/报价冻结仍先于dispatch。非strict且无caller signal的配置读取在同一microtask合为一个按key过滤的查询，5秒上限、无结果缓存；各消费者只取得其请求的key。strict和caller-owned取消路径独立。无新环境变量、表、任务或监控SQL。

### 4. Validation & Error Matrix

准备身份不匹配→预留/供应商前拒绝；早期只读Promise失败→保留拒绝供execute消费且立即挂rejection handler；配置失败沿各消费者原降级；过期配置/预留边界不得产生晚到预留；最终身份/报价失败仍释放额度。整轮6秒不因任何Promise或重试续期。

### 5. Good / Base / Bad

Good：读准备与上下文重叠、同一结果只消费一次。Base：旧直接execute调用自行准备。Bad：先等开轮/上下文，再启动相同配置；通过多发数据库请求或提前两个模型冒充提速。

### 6. Tests Required

模拟慢配置/上下文验证实际首字在6秒前交付；相同条件串行依赖会超过6秒。验证调用前身份与报价、免费/付费、停止/超时免扣、两路竞争单次结算；配置批读去重、key隔离、strict与取消隔离、后续读取保持新鲜。模拟耗时不能当生产1.5%达标证据。

### 7. Wrong vs Correct

Wrong：`await context; await config; dispatch()`。Correct：提前创建纯读准备Promise，等待既有关键写和门禁后复用其结果，再dispatch；关键身份和计费写入不能fire-and-forget。
