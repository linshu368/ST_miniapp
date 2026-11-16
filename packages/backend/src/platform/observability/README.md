# 日志模块与告警配置

日志系统的实现、规则和测试集中在本目录。规则的唯一来源是 [alert-rules.json](./alert-rules.json)，`LOG_ALERT_RULES` 环境变量不再读取，也不提供规则路径环境覆盖。修改文件后重启/重新部署生效。

## 1. 范围与入口

| 入口                                                                            | 用途                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `alert-rules.json`                                                              | 日常调整告警规则、顺序、模块、状态码和等级                          |
| `sdk.ts`                                                                        | SDK 候选稳定入口：纯核心、factory、规则与通知接口，无应用启动副作用 |
| `runtime.ts` / `fetch.ts` / `jobs.ts`                                           | 本项目装配好的默认 observer/transport/job 实例                      |
| `logger.ts` / `logger-options.ts` / `log-pretty.ts` / `conventions.ts`          | Pino 输出和安全绑定                                                 |
| `alert-config.ts` / `alert-runtime.ts`                                          | 本地文件加载及部署开关/secret、通知渠道装配                         |
| `http.ts` / `prisma.ts` / `sentry.ts` / `background.ts`                         | 框架、数据库和工程遥测适配                                          |
| `business-context.ts` / `http-business.ts` / `safe-log.ts` / `sentry-safety.ts` | 项目字段、路由、DTO 和各出口的安全投影                              |

`src/lib/logger.ts`、`logger-options.ts`、`sentry.ts`、`background-observability.ts` 只保留重导出，兼容既有业务消费者，没有第二份实现。进程 `instrumentation.ts` 和独立 Frontend 代理仍由各自运行时装配，不能跨应用导入服务端 singleton。

飞书投递 adapter 与原支付 outbox 共用，继续由 `features/alerting/` 提供；日志模块通过渠道无关接口装配它。业务监控、工程指标 exporter 与实际 route/repository 是消费者，不属于 SDK 核心。

## 2. 命令与运行时签名

```bash
pnpm --filter @miniapp/backend logging:validate
pnpm lint:backend-logging
```

配置校验命令独立于业务启动，不读取数据库配置或 webhook、不发通知；即使总开关关闭，也会验证真实文件。成功退出 0 并输出版本、规则数和启用条数；失败退出 1，只输出 `LOG_ALERT_CONFIG_INVALID`。CI 已接入。

项目配置通过 `loadLogAlertPolicy(enabled)` 加载固定的模块相对 URL；业务仍统一经 `platform/runtime-config.ts#getLogAlertSettings` 读取。应用和 worker 均不依赖启动 cwd。

## 3. 配置契约

文件外壳为 `{"version":1,"rules":[...]}`。文件最多 16 KiB，规则 1–32 条，id 唯一，未知键/版本、错误类型和越界数值拒绝。启动加载后冻结规则快照，没有 watcher、远程配置或隐式合并。

| 字段                              | 语义                                                 |
| --------------------------------- | ---------------------------------------------------- |
| id                                | 稳定唯一名称                                         |
| enabled                           | 是否参与匹配，默认 true；false 只跳过本规则          |
| severity                          | P0/P1/P2，默认 P1                                    |
| min_level                         | info/warn/error/fatal，默认 error                    |
| events / operations               | 事件/操作精确列表                                    |
| modules                           | 技术模块精确列表，如 http、db、payment               |
| business_modules                  | 来源业务精确列表，如 payment、chat；取安全业务上下文 |
| http_statuses                     | 对调用方实际响应的 HTTP 状态整数列表，100–599        |
| upstream_statuses                 | 上游 transport 状态整数列表，100–599                 |
| error_codes                       | 兼容匹配内部或公开错误码                             |
| public_error_codes                | 仅匹配公开错误码                                     |
| outcomes                          | 结果精确列表                                         |
| min_http_status / min_duration_ms | HTTP 状态下限、非负耗时下限                          |

名称/状态列表非空且最多32项。不同条件 AND，同一列表内 OR；事件缺少必需字段时不匹配。精确状态列表与下限同时存在也为 AND，没有覆盖含义。第一条匹配即发送一次；没有匹配则不通知。

当前文件内包含三个默认停用的专项示例和一个启用的 `runtime-errors` 兜底，因此开启总开关后的默认行为仍只通知 error/fatal。需要专项规则时调整其 enabled/条件，并保持兜底在最后。

```json
{
  "id": "payment-http-failures",
  "enabled": true,
  "business_modules": ["payment"],
  "operations": ["http.request"],
  "http_statuses": [500, 502, 503, 504],
  "min_level": "error",
  "severity": "P1"
}
```

该对象应放在文件的 rules 数组中。专项规则停用后，其 error 仍可能命中后续兜底；若只希望通知列出的模块，需显式移除兜底。429 transport 一般为 warn，规则应设置 min_level=warn，不能只加状态码后沿用默认 error。

总开关 `LOG_ALERTING_ENABLED` 仍默认关闭，仅字符串 true 开启；关闭时零文件读取/解析/规则匹配/通知。webhook 继续使用部署 secret，不能放入 JSON、源码、日志或示例。旧部署若有 LOG_ALERT_RULES 自定义规则，必须在发布前迁入此文件；旧变量即使存在也不生效。

## 4. 校验与故障行为

| 条件                                          | 行为                                               |
| --------------------------------------------- | -------------------------------------------------- |
| 总开关关闭、文件缺失或非法                    | 不读文件，不影响启动                               |
| 开启且文件缺失/损坏/超限/版本不支持           | fail fast，仅报稳定错误分类，不回显内容或路径      |
| 名称重复、未知键、状态为字符串/越界、规则超限 | 启动和 CI 校验拒绝                                 |
| HTTP=200，上游=429                            | 分别匹配，不把上游失败伪装成 HTTP 根状态           |
| 专项规则停用                                  | 跳过后继续查后续规则，不代表静默整个模块           |
| 多条规则同时满足                              | 仅第一条；不聚合、不去重                           |
| 通知失败、超时、过载                          | 4并发/2.5秒/无重试/存储/补传，失败隔离且不递归告警 |
| 应用/worker 换 cwd                            | 固定模块相对 URL，不改变规则来源                   |

业务执行、HTTP/SSE、供应商响应头和实际写入结果仍是不同事实。日志不能自动重试写操作，未知提交结果也不能推断成功或失败。

## 5. 公共 SDK 的预留边界

`sdk.ts` 只导出核心和 factory，不读取环境、文件，不实例化 Pino、数据库、Fastify 或具体通知渠道。底层 `fetch-core.ts`、`job-core.ts` 使用显式 observer，通知依赖 `LogAlertDelivery` 结构接口；服务名/查询提示由项目装配注入，不在 SDK 核心写死 Backend/Railway/飞书。

```typescript
import {
  createObserver,
  createObservedFetch,
  createJobObservation,
  type EventSink,
} from './sdk.js';

export function assembleProjectLogging(writeEvent: EventSink) {
  const observer = createObserver([writeEvent]);
  return {
    observer,
    fetch: createObservedFetch(observer),
    jobs: createJobObservation(observer),
  };
}
```

默认业务消费者继续使用本项目已装配的 runtime/fetch/jobs/logger 入口。只有需要独立实例或迁移时才调用上述工厂；不能额外创建一套默认 observer 导致重复日志。

这仍是 SDK 候选模块，尚未发布公共包。抽包时：

1. 保留 sdk.ts 导出的事件/上下文/factory/规则/Delivery 契约，移走项目 singleton 和文件 I/O。
2. 将 business-context.ts 的 MiniApp 字段投影及 EventFields 扩展作为目标项目的类型化适配；不得把允许用户 UUID 等同于允许任意正文/PII。
3. 按目标项目选择 HTTP/数据库/Sentry/通知 adapter，不要求安装全部 SDK。
4. Node.js 22+；核心使用 Node 内置能力和 zod，Pino 是输出适配依赖。浏览器/Edge/其他语言复用协议和验收方法，不能直接运行 AsyncLocalStorage 实现。
5. Pino 升级必须回归真实 JSON、嵌套 child/setBindings、安全 cause；当前使用其导出的 symbols 维护绑定缓存。

## 6. 验证清单

```bash
pnpm --filter @miniapp/backend exec vitest run src/platform/observability --maxWorkers=2
pnpm --filter @miniapp/backend logging:validate
node --test scripts/check-backend-logging.test.mjs
```

配置回归覆盖关闭零 I/O、旧变量被忽略、真实默认文件、未知字段/版本/超限/缺失、技术/业务模块、HTTP/上游状态、条件组合和停用规则。SDK 回归在 Pino、文件、配置、默认 runtime、框架、数据库、Sentry 或具体通知渠道导入时主动失败，验证纯入口没有拉起应用；另验证注入 transport 原结果、job 实例隔离和替换通知渠道。

迁移/发布还必须验证并发上下文、一次终态、HTTP/SSE 断开、原错误/返回值、敏感输出、通知关闭/失败/容量，并在目标部署检查 JSON 是否存在及 stdout 是否能查询。Docker 当前复制 Backend 包，文件放在 src 内随同发布；真实保存、通知与 Android/iOS/API P95 仍由发布后验收负责。

## 7. 正误对照与恢复

错误：继续调整旧规则环境变量；只过滤技术 payment 却期望覆盖所有支付 HTTP 日志；把上游429当成本接口429；停用专项规则后忽略后续兜底；把应用 runtime/file loader 导入 SDK。

正确：只改 alert-rules.json，先执行 logging:validate，按实际事件区分模块/状态，保持规则顺序；总开关/secret 独立部署，核心用 factory/接口注入。

关闭总开关并重启可停止通知；回滚应用不会改数据库。回退到旧版环境规则实现前，需要同步核对旧部署策略，不能假设新版文件会被旧程序识别。源码与配置随同版本审查和发布。
