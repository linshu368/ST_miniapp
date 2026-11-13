import { createRequire } from 'node:module';
import pino from 'pino';
import { buildPinoOptions, REDACT_PATHS } from '@miniapp/shared/src/logging/conventions';

import { resolveLogPretty } from './log-pretty.js';
import { currentContext } from '../platform/observability/context.js';
import { safeError, safeName } from '../platform/observability/events.js';
import { publishAlertLog } from '../platform/observability/log-channel.js';
import { safeLogRecord } from '../platform/observability/safe-log.js';

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
  const base = buildPinoOptions({ level: logLevel, pretty: logPretty });
  return {
    ...base,
    redact: {
      paths: [
        ...REDACT_PATHS,
        'userId',
        'user_id',
        'telegramUserId',
        'telegram_user_id',
        'username',
        'email',
        'body',
        'headers',
        'url',
        'query',
        'initData',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      ...(base.formatters as Record<string, unknown> | undefined),
      bindings: safeLogRecord,
      log: safeLogRecord,
    },
    mixin: () => ({ ...currentContext() }),
    hooks: {
      logMethod(
        this: pino.Logger,
        args: Parameters<pino.LogFn>,
        method: pino.LogFn,
        level: number
      ) {
        const first: unknown = args[0];
        if (first && typeof first === 'object' && !(first instanceof Error)) {
          const record = { ...this.bindings(), ...first };
          publishAlertLog(record, level);
          args[0] = record;
        }
        // Pino otherwise derives msg from Error.message, bypassing the err serializer.
        if (first instanceof Error) {
          method.call(this, { err: first }, 'Operation failed');
        } else if (first && typeof first === 'object' && 'err' in first) {
          method.call(this, args[0], 'Operation reported an error');
        } else {
          // Free-form messages can interpolate provider bodies, user text or URL credentials.
          const record = args[0];
          if (record && typeof record === 'object') {
            const event = 'event' in record ? record.event : undefined;
            method.call(this, record, safeName(event, 'Structured log'));
          } else method.call(this, 'Unstructured log message withheld');
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
