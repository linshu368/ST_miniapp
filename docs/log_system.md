# 蜜镜AI MiniApp 轻量日志系统 · 设计方案

> 目标：在 DAU ≤ 3 万的日常工程维护规模下，用**最小成本**建立一套严格执行的轻量级结构化日志。
> 原则：**简单集成、结构化、高性能、易于扩展**。
> 本文档为「框架收敛」阶段的落地依据；业务流水日志（还原用户行为的细粒度埋点）按模块后续补齐。

---

## 0. 一句话结论

本项目**不是从零搭建**日志系统：`backend`（Fastify 内置 pino）与 `sync-engine`（自建 pino）**已经在用 pino 且已结构化**。本轮做的是**收敛 + 规范化 + 补齐字段（`kind` 业务/系统分层）+ 统一错误暴露**，而非重造轮子。

---

## 1. 关键约束（决定了方案与通用教程不同）

| 约束       | 事实                                                                                                                                        | 对方案的影响                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 库选型     | Fastify 原生集成 **pino**，`sync-engine` 也用 pino                                                                                          | **全线统一 pino，放弃 winston**。改 winston 属倒退（拆 Fastify 内置 logger、引双份依赖、丢 per-request child logger）          |
| 部署环境   | `backend`/`st-bundle` 在 **Railway 容器**（`stminiapp` 无数据卷，重部署即丢）；`frontend`/`cs-platform` 在 **Vercel**（Serverless 只读 FS） | **只写 stdout（JSON），不写文件、不做轮转**。留存交给平台。`winston-daily-rotate-file`、"保留14天防磁盘爆炸"在 PaaS 下是反模式 |
| 并发追踪   | 本项目是 **HTTP 请求模型**，Fastify 每请求自动生成 `reqId` 并绑 child logger                                                                | 单请求链路追踪**已天然具备**，无需为此引入 AsyncLocalStorage；真正空缺是**跨边界**串联（见 §6）                                |
| 包依赖铁律 | 应用包互不 import，都可 import `shared`；`shared/src/index.ts` 的导出会被 **frontend 打包**                                                 | pino **绝不能**从 `shared` 公共导出；日志「约定」以**零依赖纯模块**下沉到 shared，pino 本体留在服务端包                        |

---

## 2. 模块落点

```
packages/shared/src/logging/
  conventions.ts       # 纯常量/类型 + buildPinoOptions()，零运行时依赖、浏览器安全
                       #   · LogKind = 'biz' | 'sys'
                       #   · 字段名常量、脱敏路径 REDACT_PATHS
                       #   · buildPinoOptions() 只返回“配置对象”，不 import pino 本体
                       #   ★不在 shared/src/index.ts 里 re-export（否则会进 frontend bundle）

packages/backend/src/lib/logger.ts       # import pino + shared/logging/conventions
packages/sync-engine/src/lib/logger.ts   # 已存在，改为复用 conventions（去重、保持 API）

packages/frontend/src/lib/logger.ts      # 极简 console 封装（不引 pino、不上报）
packages/st-extension/src/logger.ts      # 极简 console 封装（浏览器内 ST iframe）
```

- 服务端两包各自 `import pino`，把 `buildPinoOptions()` 喂进去 → **字段约定/脱敏/kind 语义单点定义**，两包输出格式强一致。
- `conventions.ts` 走深路径 `@miniapp/shared/src/logging/conventions` 引用；不碰 `index.ts`，**frontend 零感知、pino 不进浏览器 bundle**。

---

## 3. 结构化字段约定（生产 JSON 每条日志）

```jsonc
{
  "time": "2026-07-23T09:18:00.123Z", // ISO 时间
  "level": "error", // 字符串级别（非数字）
  "module": "llm-proxy", // child logger 绑定
  "kind": "sys", // ★业务/系统分层：biz=业务流水 / sys=系统&外部依赖
  "event": "upstream.timeout", // ★可选：点分事件名，便于聚合统计
  "reqId": "…", // Fastify 自动生成 / X-Request-Id 透传
  "userId": "…", // 有则带
  "msg": "…",
  "err": { "type": "Error", "message": "…", "stack": "…" }, // pino err 序列化器
}
```

- **`kind` = 一键过滤业务 vs 系统**：查 `kind=biz` 还原用户行为；查 `kind=sys` 排查外部供应商（LLM / 支付网关 / Supabase）掉链子。
- **`event`**（可选增强）：比纯文本 `msg` 更利于"昨天多少次充值失败"这类统计。
- 本地开发用 `pino-pretty` 彩色人读，字段一致。

---

## 4. `kind` 调用 API

logger 上挂两个语义化子 logger，业务代码写起来零歧义：

```ts
const log = createLogger('recharge');
log.biz.info({ event: 'recharge.start', userId, orderId }, '用户发起充值');
log.sys.error({ event: 'payment.gateway.timeout', err }, '支付网关 504');
```

对应"充值链路业务/系统交替"场景可逐条落地。Fastify 侧 `request.log`（已带 `reqId`）可用 `request.log.child({ kind: 'biz' })` 获得同等能力。

**路由 handler 统一入口（P4 落地）**：`backend/lib/logger.ts` 的 `requestLogger(request.log, module)` 复用 `request.log` 的 `reqId`、补 `module`、并挂 `.biz`/`.sys`。这是路由内打业务流水的规范写法：

```ts
const log = requestLogger(request.log, 'recharge');
log.biz.info({ event: 'recharge.order.create', userId, orderId }, '用户创建充值订单');
log.sys.error({ event: 'payment.webhook.complete_failed', err, orderId }, '订单完成处理失败');
```

`sync-engine` 侧模块用 `createLogger(module).biz/.sys`（同源）；`lib` 内非请求作用域（如 `chat-history-logger`）用 `log.child({ module })` + 内联 `{ kind, event }`。

**`event` 命名法**：统一 `<domain>.<object>.<action>`，便于按事件聚合统计。已落地事件族：`stsession.*` / `provision.*`（登录·下发）、`recharge.*` / `payment.webhook.*`（充值·回调）、`llm.*` / `chathistory.*`（生成·落库）、`models.select.*`、`chats.*`、`favorites.*`、`sync_task.*` / `watcher.*` / `file_watcher.*`（回流队列）。

> 本轮已交付**能力 + 核心链路打点**；wallet/wishes/bot/growth/cs-platform 等外围模块的细粒度业务打点可沿用同一范式后续按需补齐。

---

## 5. 分级与开关

| 级别            | 用途                                      | 处置                      |
| --------------- | ----------------------------------------- | ------------------------- |
| `trace`/`debug` | 开发排查                                  | 仅本地/按需               |
| `info`          | 正常业务流水（用户开始对话、LLM 耗时等）  | 存日志，不报警            |
| `warn`          | 不影响核心业务但需注意（如 LLM 上游 >5s） | 存日志，可视情况报警      |
| `error`         | 程序异常、上游 5xx、DB 断连               | 存日志 + 未来触发飞书报警 |
| `fatal`         | 进程级不可恢复                            | 存日志 + 告警             |

- `LOG_LEVEL` 环境变量统一控制（`sync-engine` 已有，`backend` 本轮补齐）。
- 默认 `info`；`NODE_ENV=test` → `silent`；生产 JSON、本地 pretty。

---

## 6. Trace / 请求关联

- **单请求内**：Fastify `reqId` 已天然串联，无需 AsyncLocalStorage。
- **跨边界**：约定透传 `X-Request-Id` header（frontend/ST → backend；backend → sync-engine 内网调用带上）。Fastify `genReqId` 优先复用入站该 header，否则生成。
- **LLM 轮次**：`miniapp.chat_history` 已有 `charge_id` / `generation_id`，作为一次生成的天然关联键，日志带上即可与落库记录对齐。
- **AsyncLocalStorage**：列为二期可选（用于消除像 `chat-history-logger` 那样手动透传 `log` 参数的样板），不阻塞本轮。

---

## 7. 错误暴露规范（硬要求）

> 报错必须暴露最底层、不封装隐藏。定位问题优先。

- **禁止** `logger.error({ err: String(err) }, ...)` —— 会丢掉 stack 与 cause 链。
- **必须**传原始 `Error` 对象：`logger.error({ err }, '...')`，由 pino `err` 序列化器保留 `type/message/stack`。
- 若确需附加封装信息，原始报错仍要一并呈现（`{ err, context }`），不得只留封装后的信息。
- 不得用 `try/catch` 静默吞掉错误。

---

## 8. 脱敏（安全底线）

`conventions.ts` 维护 `REDACT_PATHS`，用 pino `redact` 自动打码，避免把敏感信息写进日志：

- HTTP：`authorization`、`X-Init-Data`（TG initData）、`apikey`、`cookie`
- 密钥/令牌：`api_key_custom`（per-user JWT）、`*.token`、`*.secret`、支付密钥
- 打码值统一 `[REDACTED]`

---

## 9. 飞书告警伏笔（本轮不实现）

设计为 pino **transport target**：二期新增 `feishu-transport`（监听 `level>=error` 的日志流 → POST Webhook）。本轮只把 logger 配置写成"可加 transport"的形态，接入时业务代码零改动。

---

## 10. 客户端极简封装（本轮最小交付）

`frontend` / `st-extension` 各加一个 `logger.ts` 薄封装：`console.*` + `[module]` 前缀 + 生产环境静音 `debug`。**不引 pino、不上报**。统一口径，二期若要上报只改封装内部。

---

## 11. 落地阶段

| 阶段 | 内容                                                                                                                                                                      | 本轮        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| P1   | `shared/src/logging/conventions.ts`（kind/字段/脱敏/buildPinoOptions）                                                                                                    | ✅ 框架收敛 |
| P2   | `backend/lib/logger.ts` + `app.ts` 用实例替换 `logger:true` + `genReqId` 复用 `X-Request-Id` + `server.ts` 去裸 console                                                   | ✅ 框架收敛 |
| P3   | `sync-engine/lib/logger.ts` 复用 conventions（保持 `createLogger` 签名）                                                                                                  | ✅ 框架收敛 |
| P5   | 前端/扩展极简 console 封装 + 中枢 `client.ts` 迁移示范                                                                                                                    | ✅ 框架收敛 |
| P4   | **业务流水日志补齐**（充值/LLM/provision/支付回调 + 模型切换/历史聊天/收藏/chat_history/watcher 队列）+ 服务端日志 `String(err)` → `{ err }` 全量迁移 + 补 `kind`/`event` | ✅ 本轮     |
| P6   | 飞书 transport + AsyncLocalStorage + 可选日志 drain                                                                                                                       | ⏳ 二期     |

---

## 12. 非目标（明确不做）

- ❌ winston / `winston-daily-rotate-file`（PaaS 反模式）
- ❌ 本地日志文件与轮转清理
- ❌ 一期客户端日志远程上报
- ❌ 为追踪单请求引入 AsyncLocalStorage（Fastify `reqId` 已够）
