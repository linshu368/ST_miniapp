/**
 * sync-engine / lib / config.ts
 *
 * 环境变量加载与校验。
 * 使用 Zod 在启动时做 fail-fast 校验，避免运行到一半才发现配置缺失。
 * 调用 loadConfig() 一次后缓存，后续模块直接 import { config }。
 */

import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL 必须是合法 URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10, 'SUPABASE_SERVICE_ROLE_KEY 不能为空'),

  // ST 文件系统
  ST_DATA_PATH: z.string().min(1, 'ST_DATA_PATH 不能为空'),
  ST_PLATFORM_ASSETS_PATH: z.string().min(1, 'ST_PLATFORM_ASSETS_PATH 不能为空'),

  // ST 服务
  ST_BASE_URL: z.string().url('ST_BASE_URL 必须是合法 URL'),
  ST_ADMIN_USERNAME: z.string().min(1).default('admin'),
  ST_ADMIN_PASSWORD: z.string().min(1, 'ST_ADMIN_PASSWORD 不能为空'),
  ST_USER_PASSWORD_SECRET: z.string().min(16, 'ST_USER_PASSWORD_SECRET 至少 16 位'),

  // 健康监控（默认 9090，0 = 禁用）
  HEALTH_PORT: z
    .string()
    .default('9090')
    .transform((v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0 || n > 65535) {
        throw new Error('HEALTH_PORT 必须是 0-65535 的整数');
      }
      return n;
    }),

  // Bridge API 内网端口（供 backend 调用 provision，默认 9091，0 = 禁用）
  BRIDGE_API_PORT: z
    .string()
    .default('9091')
    .transform((v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0 || n > 65535) {
        throw new Error('BRIDGE_API_PORT 必须是 0-65535 的整数');
      }
      return n;
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`环境变量配置校验失败：\n${details}\n\n请检查 .env 文件是否存在且已正确填写。`);
  }

  _config = result.data;
  return _config;
}

/** 模块级单例，供其他模块直接 import 使用 */
export const config = new Proxy({} as Config, {
  get(_target, key: string) {
    return loadConfig()[key as keyof Config];
  },
});
