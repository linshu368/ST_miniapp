/**
 * sync-engine / lib / logger.ts
 *
 * 基于 pino 的结构化日志。复用 `@miniapp/shared` 的日志约定（字段/脱敏/kind），
 * 与 backend 输出格式保持一致。
 *
 * 用法：
 *   import { createLogger } from '../lib/logger.js'
 *   const log = createLogger('watcher')
 *   log.info('启动完成')
 *   log.warn('handle 未找到对应用户', { handle: 'tg_123' })
 *   log.sys.error({ event: 'upload.failed', taskId, err }, '上传失败')
 *
 * 输出格式：
 *   - NODE_ENV=production：JSON（机器可解析，stdout）
 *   - 其他：pretty（彩色人读）
 *
 * 日志级别：LOG_LEVEL 控制（trace/debug/info/warn/error/fatal/silent）
 *   默认 info；测试中设为 silent
 *
 * 报错请传原始 Error 对象 `{ err }`，禁止 String(err) 丢栈（见 docs/日志系统.md §7）。
 */

import pino from 'pino';
import { buildPinoOptions, type LogKind } from '@miniapp/shared/src/logging/conventions';

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
const pretty = process.env.NODE_ENV !== 'production';

const rootLogger = pino(buildPinoOptions({ level, pretty }) as unknown as pino.LoggerOptions);

export type Logger = pino.Logger & { biz: pino.Logger; sys: pino.Logger };

/**
 * 创建带模块标识的 child logger。
 * 所有 log 行会自动带 module=<name> 字段。
 * 额外挂载 .biz / .sys 子 logger，分别固定 kind=biz / kind=sys。
 */
export function createLogger(module: string): Logger {
  const child = rootLogger.child({ module });
  return Object.assign(child, {
    biz: child.child({ kind: 'biz' satisfies LogKind }),
    sys: child.child({ kind: 'sys' satisfies LogKind }),
  }) as Logger;
}

/** 直接暴露 root logger，用于无明确模块归属的场景 */
export const logger = rootLogger;
