# Backend 数据、可靠性、安全与可观测性

## 数据访问边界

- Prisma 只映射 `app_core`、`miniapp_features`、`billing`；schema 变更唯一源是 `packages/shared/migrations/`。
- 其他域通过显式 schema client/RPC/repository。跨域写入用事务/RPC或明确补偿，不在 route 串联多次写后忽略半成功。
- repository 返回领域对象，不泄漏数据库行。列表必须稳定排序、有界分页；批量/导出评估行数、内存、超时，避免 N+1。

## 配置、秘密与鉴权

- `platform/config.ts` 统一解析启动配置并 fail fast；运行时运营配置只走 `runtime-config.ts` 的 TTL/version/降级机制。
- 禁止 secret、token、完整 initData、签名材料、DB URI、消息正文进入源码、Markdown、URL或日志。
- MiniApp 用 `requireTelegramAuth`；CS/Admin/Bot 沿用各自 token/session/webhook secret。鉴权后仍需资源 ownership/角色授权；service role 仅在后端。
- CORS 只允许配置 origin；不得用带凭证的无约束 `*`。

## 故障模型硬规则

| 风险 | REQUIRED                                                                             |
| ---- | ------------------------------------------------------------------------------------ |
| 超时 | 每个 HTTP/LLM/TTS/Telegram/支付/Redis 调用有明确 timeout；整体 deadline 不因重试重置 |
| 重试 | 有限、退避加抖动；仅幂等读或具幂等键写；尊重 429/Retry-After                         |
| 幂等 | 支付、奖励、归因、开轮、语音指定业务键和重复请求结果                                 |
| 并发 | 会话、钱包、结算使用行锁/unique/原子 RPC，不用进程锁替代 DB 一致性                   |
| 事务 | 多表不变量使用事务/RPC；跨外部系统写清提交点、补偿、对账                             |
| 降级 | 配置有安全默认；非核心通知/遥测失败不破坏主交易；关键失败不静默吞掉                  |
| 容量 | SSE、导出、轮询、音频/大 JSON 有大小、并发、时间上限                                 |
| 恢复 | 重启后可重放或由 sync/reconciliation job 收敛，记录停止条件和人工入口                |

高可用不是默认增加队列/缓存/adapter。只有真实故障需要且可验证时才增加组件；优先数据库约束、有限重试、已有 job 和清晰错误。

## 可观测性与发布

- 使用现有 pino、`requestLogger`；原始异常写 `{ err }`。Sentry 先脱敏再附 context。
- 关键流程记录阶段、耗时、状态/计数、安全幂等摘要、provider/request id；job 记录扫描/推进/失败数，禁止逐行高频 info。
- 发布顺序：兼容 migration → backend producer → consumers → 清理旧字段。说明旧数据、灰度/停止条件、rollback 或 forward-fix。生产 migration 手动逐文件，先 test 验证 shape、RLS/权限、读写、锁/容量和回滚。
