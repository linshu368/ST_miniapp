/**
 * st-extension / logger.ts
 *
 * 极简客户端日志封装（注入 ST iframe 内的浏览器环境）。
 * 本轮只统一口径，不引 pino、不做远程上报。
 *
 * 用法：
 *   import { createLogger } from './logger.js'
 *   const log = createLogger('bridge-server')
 *   log.debug('...')   // 默认静音；置 globalThis.__MINIAPP_DEBUG__ = true 开启
 *   log.error('...')
 *
 * 说明：
 *   - 这里运行在 tsup IIFE（platform=browser）里，**没有 process.env**，
 *     因此 debug 开关走运行时全局标志 __MINIAPP_DEBUG__，而非 NODE_ENV。
 *   - info/warn/error 始终输出，便于线上排查。
 */

export interface ClientLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function debugEnabled(): boolean {
  return (globalThis as { __MINIAPP_DEBUG__?: boolean }).__MINIAPP_DEBUG__ === true;
}

export function createLogger(module: string): ClientLogger {
  const prefix = `[${module}]`;
  return {
    debug: (...args: unknown[]) => {
      if (debugEnabled()) console.debug(prefix, ...args);
    },
    info: (...args: unknown[]) => console.info(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}
