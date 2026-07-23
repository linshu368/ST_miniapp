/**
 * frontend / lib / logger.ts
 *
 * 极简客户端日志封装（浏览器）。本轮只统一口径，不引 pino、不做远程上报。
 *
 * 用法：
 *   import { createLogger } from '@/lib/logger'
 *   const log = createLogger('api')
 *   log.debug('Fetching', { url })   // 生产环境静音
 *   log.error('请求失败', err)
 *
 * 说明：
 *   - 生产环境（NODE_ENV=production）静音 debug，保留 info/warn/error。
 *   - 二期若要上报，只改本文件内部，业务调用点无需变更。
 */

const isProd = process.env.NODE_ENV === 'production';

export interface ClientLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createLogger(module: string): ClientLogger {
  const prefix = `[${module}]`;
  return {
    debug: (...args: unknown[]) => {
      if (!isProd) console.debug(prefix, ...args);
    },
    info: (...args: unknown[]) => console.info(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}
