/**
 * sync-engine / lib / logger.ts
 *
 * 基于 pino 的结构化日志。
 *
 * 用法：
 *   import { createLogger } from '../lib/logger.js'
 *   const logger = createLogger('watcher')
 *   logger.info('启动完成')
 *   logger.warn('handle 未找到对应用户', { handle: 'tg_123' })
 *   logger.error('上传失败', { taskId, error: err.message })
 *
 * 输出格式：
 *   - NODE_ENV=production：JSON（机器可解析）
 *   - 其他：pretty（彩色人读）
 *
 * 日志级别：通过环境变量 LOG_LEVEL 控制（trace/debug/info/warn/error/fatal/silent）
 *   默认 info；测试中设为 silent
 */

import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

const rootLogger = pino({
  level,
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
            messageFormat: '[{module}] {msg}',
          },
        },
      }),
});

export type Logger = pino.Logger;

/**
 * 创建带模块标识的 child logger。
 * 所有 log 行会自动带 module=<name> 字段。
 */
export function createLogger(module: string): Logger {
  return rootLogger.child({ module });
}

/** 直接暴露 root logger，用于无明确模块归属的场景 */
export const logger = rootLogger;
