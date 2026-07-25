import { resolveDefaultUserAvatarUrl } from '@miniapp/shared';

/**
 * 平台默认头像。生产通过 NEXT_PUBLIC_DEFAULT_USER_AVATAR_URL 指向生产 Supabase，
 * 未配置时回退到共享包里的测试环境地址。必须保留字面量写法供 Next 在构建期内联。
 */
export const DEFAULT_USER_AVATAR_URL = resolveDefaultUserAvatarUrl(
  process.env.NEXT_PUBLIC_DEFAULT_USER_AVATAR_URL
);
