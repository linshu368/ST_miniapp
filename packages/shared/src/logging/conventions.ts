/**
 * shared / logging / conventions.ts
 *
 * 日志系统的「约定层」：零运行时依赖、浏览器安全。
 *
 * 关键纪律：
 *   - 本文件**不 import pino**（也不 import 任何运行时库），只产出「配置对象」。
 *   - 本文件**不得**从 `shared/src/index.ts` re-export，否则会被打进 frontend bundle。
 *   - 服务端包（backend / sync-engine）各自 `import pino`，把 buildPinoOptions() 喂进去，
 *     从而保证字段约定 / 脱敏清单 / kind 语义**单点定义**、两端输出格式一致。
 *
 * 设计见 docs/日志系统.md。
 */

/** 业务/系统分层：biz=业务流水（还原用户行为）/ sys=系统&外部依赖（修 Bug） */
export type LogKind = 'biz' | 'sys';

/** 结构化日志固定字段名（供两端引用，避免各写字符串字面量） */
export const LOG_FIELD = {
  kind: 'kind',
  event: 'event',
  module: 'module',
  reqId: 'reqId',
  userId: 'userId',
  err: 'err',
} as const;

/**
 * 脱敏路径（pino `redact` 语法）。
 * 避免把 TG initData / per-user JWT / 支付凭证 / cookie 等写进日志。
 */
export const REDACT_PATHS: readonly string[] = [
  // HTTP 请求头（Fastify req 序列化后位于 req.headers.*）
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-init-data"]',
  'req.headers["x-cs-admin-token"]',
  'req.headers["x-bot-internal-secret"]',
  'req.headers.apikey',
  'headers.authorization',
  'headers.cookie',
  'headers["x-init-data"]',
  // 通用敏感键（顶层 + 一层通配）
  'authorization',
  'cookie',
  'token',
  'password',
  'secret',
  'api_key_custom',
  '*.token',
  '*.password',
  '*.secret',
  '*.api_key_custom',
];

export const REDACT_CENSOR = '[REDACTED]';

export interface BuildPinoOptionsInput {
  /** 日志级别：trace/debug/info/warn/error/fatal/silent。默认 info */
  level?: string;
  /** 本地彩色人读（pino-pretty）。生产为 false → stdout JSON */
  pretty?: boolean;
}

/**
 * 产出 pino LoggerOptions（以纯对象形式返回，不引用 pino 本体）。
 *
 * - 生产（pretty=false）：JSON、ISO 时间、字符串级别、自动脱敏。
 * - 本地（pretty=true）：交给 pino-pretty transport 彩色渲染。
 *
 * 返回值可直接作为 pino() 参数或 Fastify `logger` 选项（调用侧做一次类型断言）。
 */
export function buildPinoOptions(input: BuildPinoOptionsInput = {}): Record<string, unknown> {
  const level = input.level ?? 'info';
  const pretty = input.pretty ?? false;

  const options: Record<string, unknown> = {
    level,
    redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
  };

  if (pretty) {
    // 本地：pino-pretty 在 worker 线程渲染，数字级别 + 彩色更易读
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '[{module}] {msg}',
      },
    };
  } else {
    // 生产：stdout JSON，字符串级别 + ISO 时间（便于平台侧检索）
    options.timestamp = () => `,"time":"${new Date().toISOString()}"`;
    options.formatters = {
      level(label: string) {
        return { level: label };
      },
    };
  }

  return options;
}
