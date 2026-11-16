# 业务关联字段调研（2026-11-14）

仅检查本地源码，未读取生产日志、业务行或部署配置。

| 来源                                                                      | 当前事实与处理                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `platform/observability/context.ts`、`core.ts`、`http.ts`                 | ALS 仅持有链路字段，HTTP operation 在鉴权前建立。扩展业务关联容器并让终态读取已获得的字段，不能只在单条日志附 ID。                   |
| `platform/observability/events.ts`、`safe-log.ts`                         | EventFields 和 legacy Pino 白名单不保留用户/会话/角色等字段；扩展统一受控投影。                                                      |
| `lib/logger-options.ts`                                                   | 显式 redact userId/user_id/telegramUserId/telegram_user_id；新的安全 ID 投影需与 redact 一起调整，否则 Railway 只看到 REDACTED。     |
| `middleware/auth.ts`、`lib/user.ts`                                       | request.user.id 是 Telegram 身份，getOrCreateDbUser 返回内部 UUID，且有缓存/共享 inflight；绑定必须在每个调用者 await 后进行。       |
| `routes/drama.ts`、`drama-play.ts`                                        | 浏览/播放只验 Telegram，无内部用户查询；保留此性能行为，输出已验签 telegram_user_id，POST 播放在已有 UUID 校验后补剧/集。            |
| `features/creator/repository.ts`、`routes/creator-characters.ts`          | CreationRow 主键是 character_id，返回 CreatorCharacter.id 同值；不存在独立创作项目 ID，creation_id 只在创作语义下等于 character_id。 |
| `infrastructure/repositories/ChatSessionRepository.ts`                    | getSession 已按 session/user/deleted_at 校验；复用取得的记录补 character_id，不另查库。                                              |
| `platform/observability/sentry-safety.ts`、`log-channel.ts`               | Sentry 复用 safeLogRecord，必须单独保持身份禁区；通知 AlertLog 窄投影保持不含用户/对象。                                             |
| `packages/shared/src/api/*`、`packages/shared/src/logging/conventions.ts` | 复用已有 ID/业务契约，无新增公开字段，无需 shared DTO 变更。无需组件/hooks、repository 新查询、数据库函数或 migration。              |

与现状差异：旧文档宣称安全白名单有意丢弃个人信息，实际也丢弃了排障用内部 ID；本次仅授权受控业务标识进入 Railway，不开放正文、任意个人资料、通知或遥测标签。运行说明必须标注本地实现和线上验收的区别。
