/**
 * backend / lib / logger.ts
 *
 * 基于 pino 的结构化日志。复用 `@miniapp/shared` 的日志约定（字段/脱敏/kind）。
 *
 * 用法：
 *   import { createLogger } from './lib/logger.js'
 *   const log = createLogger('recharge')
 *   log.info('普通信息', { orderId })
 *   log.biz.info({ event: 'recharge.start', userId, orderId }, '用户发起充值')
 *   log.sys.error({ event: 'payment.gateway.timeout', err }, '支付网关 504')
 *
 * 说明：
 *   - Fastify 的 `request.log`（已带 reqId）与本 logger 输出格式一致；两者共存。
 *   - 报错请传原始 Error 对象 `{ err }`，由 pino err 序列化器保留 stack/cause，
 *     禁止 `String(err)` 丢栈（见 docs/日志系统.md §7）。
 *   - 输出：NODE_ENV=production → stdout JSON；否则 pino-pretty 彩色。
 *   - 级别：LOG_LEVEL 控制；test 默认 silent。
 */

import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { buildPinoOptions, type LogKind } from '@miniapp/shared/src/logging/conventions';

export const logLevel =
  process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
export const logPretty = process.env.NODE_ENV !== 'production';

/** 供 Fastify `logger` 选项复用，保证应用日志与 request 日志同源同格式 */
export function fastifyLoggerOptions(): Record<string, unknown> {
  return buildPinoOptions({ level: logLevel, pretty: logPretty });
}

const rootLogger = pino(fastifyLoggerOptions() as unknown as pino.LoggerOptions);

export type Logger = pino.Logger & { biz: pino.Logger; sys: pino.Logger };

/**
 * 创建带模块标识的 logger（自动带 module=<name> 字段）。
 * 额外挂载 .biz / .sys 两个子 logger，分别固定 kind=biz / kind=sys。
 */
export function createLogger(module: string): Logger {
  const child = rootLogger.child({ module });
  return Object.assign(child, {
    biz: child.child({ kind: 'biz' satisfies LogKind }),
    sys: child.child({ kind: 'sys' satisfies LogKind }),
  }) as Logger;
}

/** root logger，用于无明确模块归属或进程级场景（如启动失败） */
export const logger = rootLogger;

/**
 * 请求内 logger：在 module 维度上复用 Fastify `request.log`（已带 reqId），
 * 再挂 .biz / .sys 两个子 logger（分别固定 kind=biz / kind=sys）。
 *
 * 相比 createLogger()，它保留了单请求链路 reqId；相比裸 request.log，它补齐了
 * module + kind/event 能力，是路由 handler 打业务流水日志的统一入口。
 *
 * 用法：
 *   const log = requestLogger(request.log, 'recharge')
 *   log.biz.info({ event: 'recharge.order.create', userId, orderId }, '用户创建充值订单')
 *   log.sys.error({ event: 'payment.gateway.timeout', err }, '支付网关 504')
 */
export type RequestLogger = FastifyBaseLogger & {
  biz: FastifyBaseLogger;
  sys: FastifyBaseLogger;
};

export function requestLogger(baseLog: FastifyBaseLogger, module: string): RequestLogger {
  const child = baseLog.child({ module });
  return Object.assign(child, {
    biz: child.child({ kind: 'biz' satisfies LogKind }),
    sys: child.child({ kind: 'sys' satisfies LogKind }),
  });
}
