# Backend 架构、入口与文件职责

## 请求与进程入口

| 路径                     | 职责与使用约束                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/instrumentation.ts` | 在业务模块前初始化 Sentry；必须早于 `server.ts` 导入                                                  |
| `src/server.ts`          | 加载配置、创建 app、监听端口、启动/停止进程内任务并处理优雅退出；不要放业务 handler                   |
| `src/app.ts`             | `buildApp()`、CORS、全局 hook/error handler、全部 route plugin 注册和 `/health`；新增路由插件在此接线 |
| `src/middleware/auth.ts` | Telegram initData、CS/Admin 等既有鉴权入口；handler 不得复制验签逻辑                                  |
| `src/types/*`            | 配置结构与 Fastify 类型扩展，不承载对外 DTO                                                           |

依赖方向：`server/app → routes → features/use cases → repositories/infrastructure → DB/外部系统`；共享 DTO 从 `@miniapp/shared` 向内流动。routes 不应承载复杂计费、prompt、支付状态机或 SQL。

## `src/features/`

- `billing/`：角色免费额度与 usage 定价纯逻辑。
- `community/`：官方群配置与 Telegram Bot API 客户端。
- `conversations/`：`generate.ts` 一轮编排，`history.ts` 展开历史，`context-window.ts` 水位窗口，`sse.ts` 事件编码，`errors.ts` 错误归一，`user-placeholder.ts` 昵称占位。
- `engine/`：`prompt-engine.ts` 组消息，`render-instructions.ts` 渲染模板，`platform-instructions.ts` 取平台规则，`types.ts/index.ts` 定义内部边界；除配置读取外尽量纯函数。
- `generation/`：生成/计费唯一出口；`execute.ts` 编排，`precheck.ts` 余额预检，`quota.ts` 免费额度，`resolve-model.ts` 模型解析，`prompt-caching.ts` 缓存策略，`upstream.ts` OpenRouter 流，`voice-billing.ts` 语音策略。
- `lobby/`：精选、置顶、推荐排序参数/分数/统计与刷新。
- `payment/domain/`：充值规则；`payment/usecases/`：下单、结算、回调报告、快速对账、订单过期。
- `voice/`：语音文本/提示词/草稿、音色目录、MiniMax/DeepSeek 上游、生成编排与计费配置。

## `src/infrastructure/`

- `payment/ZqPaymentGateway.ts`：支付供应商签名、请求/查询和响应适配，不决定业务结算规则。
- `redis/UpstashConfigStore.ts`：远端配置缓存适配。
- `repositories/CharacterCardRepository.ts`：角色卡；`ChatSessionRepository.ts`、`ConversationHistoryRepository.ts`：会话、历史、原子开轮；`ChatMessageAudioRepository.ts`：音频；`CsPlatformRepository.ts`：CS。
- `MiniappCharacterFavoriteRepository.ts`、`MiniappCharacterFreeQuotaRepository.ts`、`MiniappPaymentOrderRepository.ts`、`MiniappUserSettingsRepository.ts`、`MiniappWalletRepository.ts`、`MiniappWishRoleRepository.ts`：各业务域持久化。
- `conversation-errors.ts` 归一 repository 错误；`effective-display-name.ts` 计算展示昵称。

Repository 隐藏 schema client/Prisma 行形状，返回领域结果；跨 schema 行为优先 RPC/API，不在 handler 拼跨域查询。

## `src/lib/`、`src/platform/` 与其他目录

- `lib/db.ts`：Prisma 单例；`lib/supabase.ts`：按域 Supabase client。
- `lib/logger.ts`/`log-pretty.ts`：pino；`lib/sentry.ts`：监控与脱敏。
- `chat-history-logger.ts` + `chat-history-sync-job.ts`：终态即时记录与轮询补齐；`chat-voice-storage.ts`：语音 Storage。
- `lobby-ranking-refresh-job.ts`/`lobby-latest-badge.ts`：大厅后台能力；`notifications.ts`/`notification-scope.ts`、`support-unread.ts`：通知/客服；`telegram-links.ts`、`user-avatar.ts`、`user.ts`：边界工具。
- `platform/config.ts`：环境变量解析唯一中心；`runtime-config.ts`：DB 配置读取唯一入口；`model-tiers.ts`、`openrouter-models.ts`：模型档位和目录。
- `prisma/schema.prisma` 是 Prisma 映射，不是共享契约；`prisma/migrations/` 是历史，当前 migration 唯一源仍是 `packages/shared/migrations/`；`seed.ts` 保护开发 fixture。
- `scripts/payment-*` 执行支付诊断/对账/过期；`seed-config.ts` 初始化配置。阶段 `invite-uat/`、`mvp-regression/` 已删除，不得作为现行场景验证器。
- `*.test.ts` 与源码就近；integration test 必须显式确认 test DB，不能让普通单测意外访问远端。

## 新文件放置规则

HTTP 解析/状态码放 route；业务编排放 feature/usecase；纯规则放 domain/feature；DB 操作放 repository；第三方协议放 infrastructure；跨域基础设施放 lib/platform。只有出现第二个真实 consumer 才提取通用抽象，禁止创建大杂烩或第二套 client。
