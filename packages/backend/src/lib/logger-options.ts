import { createRequire } from 'node:module';
import pino from 'pino';
import { buildPinoOptions, REDACT_PATHS } from '@miniapp/shared/src/logging/conventions';

import { resolveLogPretty } from './log-pretty.js';
import { contextLogFields } from '../platform/observability/context.js';
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

function sanitizeChildBindings(child: pino.Logger): void {
  // Pino resets the bindings formatter for children and caches their JSON before onChild.
  // Rebuild that cache once, using Pino's exported symbols; never parse every output line.
  const target = child as pino.Logger & {
    [pino.symbols.chindingsSym]: string;
    [pino.symbols.formattersSym]: NonNullable<pino.LoggerOptions['formatters']>;
  };
  const bindings = child.bindings();
  target[pino.symbols.formattersSym] = {
    ...target[pino.symbols.formattersSym],
    bindings: safeLogRecord,
    log: safeLogRecord,
  };
  target[pino.symbols.chindingsSym] = '';
  child.setBindings(bindings);
}

/** 供 Fastify `logger` 选项复用，保证应用日志与 request 日志同源同格式 */
export function fastifyLoggerOptions(): Record<string, unknown> {
  const base = buildPinoOptions({ level: logLevel, pretty: logPretty });
  return {
    ...base,
    onChild: sanitizeChildBindings,
    redact: {
      paths: [
        ...REDACT_PATHS,
        'telegramUserId',
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
    mixin: () => contextLogFields(),
    hooks: {
      logMethod(
        this: pino.Logger,
        args: Parameters<pino.LogFn>,
        method: pino.LogFn,
        level: number
      ) {
        const first: unknown = args[0];
        const record: Record<string, unknown> = {
          ...this.bindings(),
          ...(first instanceof Error
            ? { err: first }
            : first && typeof first === 'object'
              ? first
              : {}),
          ...contextLogFields(),
        };
        // Legacy failures (including Fastify's own errors) must not silently bypass alerts.
        // Fixed fallback names cannot expose interpolated text or Error.message.
        if (level >= 40 && typeof record.event !== 'string')
          record.event =
            level >= 60 ? 'logger.fatal' : level >= 50 ? 'logger.error' : 'logger.warn';
        publishAlertLog(record, level);
        method.call(this, record, safeName(record.event, 'Structured log'));
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
