import { z } from 'zod';

/**
 * 运营平台 CLI 免密登录：只凭白名单邮箱签发该运营账号的 Supabase 会话。
 * 白名单在后端环境变量 ADMIN_CLI_ALLOWED_EMAILS，未配置时接口关闭。
 */
export const AdminCliSessionRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

export type AdminCliSessionRequest = z.infer<typeof AdminCliSessionRequestSchema>;

export const AdminCliSessionDataSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    /** Unix 秒；Supabase 未返回时为 null */
    expires_at: z.number().int().nullable(),
    user_id: z.string().uuid(),
  })
  .strict();

export type AdminCliSessionData = z.infer<typeof AdminCliSessionDataSchema>;
