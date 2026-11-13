import { createRequire } from 'node:module';
import pino from 'pino';
import { buildPinoOptions } from '@miniapp/shared/src/logging/conventions';

import { resolveLogPretty } from './log-pretty.js';
import { currentContext } from '../platform/observability/context.js';
import { safeError } from '../platform/observability/events.js';

export const logLevel =
  process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

function isPinoPrettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/** 仅在明确想要彩色、且依赖可解析时启用；缺包时回退 JSON，保证进程能起。 */
export const logPretty = resolveLogPretty({
  nodeEnv: process.env.NODE_ENV,
  logPrettyEnv: process.env.LOG_PRETTY,
  prettyAvailable: isPinoPrettyAvailable(),
});

/** 供 Fastify `logger` 选项复用，保证应用日志与 request 日志同源同格式 */
export function fastifyLoggerOptions(): Record<string, unknown> {
  return {
    ...buildPinoOptions({ level: logLevel, pretty: logPretty }),
    mixin: () => ({ ...currentContext() }),
    hooks: {
      logMethod(args: Parameters<pino.LogFn>, method: pino.LogFn) {
        const first: unknown = args[0];
        // Pino otherwise derives msg from Error.message, bypassing the err serializer.
        if (first instanceof Error) {
          method.call(this, { err: first }, 'Operation failed');
        } else if (first && typeof first === 'object' && 'err' in first) {
          method.call(this, first, 'Operation reported an error');
        } else {
          method.apply(this, args);
        }
      },
    },
    // GET 支付通知包含可重放签名和商品信息。自动请求日志只保留路径与链路。
    serializers: {
      err: safeError,
      req(req: { method?: string; url?: string; id?: string }) {
        return { method: req.method, url: req.url?.split('?')[0], id: req.id };
      },
    },
  };
}

/** Bootstrap logging must also work before database/runtime config initialization. */
export function foundationLoggerOptions(): pino.LoggerOptions {
  return {
    ...fastifyLoggerOptions(),
    level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
  };
}
