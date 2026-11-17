import { createRequire } from 'node:module';
import pino from 'pino';
import { buildPinoOptions, REDACT_PATHS } from './conventions.js';

import { resolveLogPretty } from './log-pretty.js';
import { contextLogFields } from './context.js';
import { safeError, safeName } from './events.js';
import { publishAlertLog } from './log-channel.js';
import { safeLogRecord } from './safe-log.js';
import { createLogPresentation, type LogPresentation } from './presentation.js';
import { chineseLogCatalog } from './labels.zh-CN.js';

const renderPresentation = createLogPresentation(chineseLogCatalog);
const PRESENTATION = Symbol('trustedLogPresentation');

function presentationFor(record: Record<string, unknown>, level: number): LogPresentation {
  try {
    return renderPresentation(safeLogRecord(record), level);
  } catch {
    return {
      msg: safeName(record.event, 'Structured log'),
      module_name: '系统',
      scenario: '日志摘要生成失败',
      result: '结果未确认',
    };
  }
}

function formatLogRecord(record: Record<string, unknown>): Record<string, unknown> {
  const display =
    (record as { [PRESENTATION]?: LogPresentation })[PRESENTATION] ?? presentationFor(record, 30);
  const { msg: _msg, ...fields } = display;
  // Derived fields lead Railway's detail view; untrusted caller-supplied display strings are dropped.
  return { ...fields, ...safeLogRecord(record) };
}

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
    log: formatLogRecord,
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
      log: formatLogRecord,
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
        const display = presentationFor(record, level);
        method.call(this, { ...record, [PRESENTATION]: display }, display.msg);
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
