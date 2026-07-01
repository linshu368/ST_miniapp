// 从 Telegram initData 提取当前用户信息
// 业务代码取 displayName 应走 useUserProfileStore,这里只负责"原始默认值"的解析
import { getRawInitData } from './auth';

export interface TelegramUserInfo {
  id?: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
}

/** 解析 raw initData(URL-encoded query string)中的 user 字段 */
export function parseTelegramUser(rawInitData: string | undefined): TelegramUserInfo {
  if (!rawInitData) return {};
  try {
    const params = new URLSearchParams(rawInitData);
    const userParam = params.get('user');
    if (!userParam) return {};
    const user = JSON.parse(userParam) as {
      id?: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      photo_url?: string;
    };
    return {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
      photoUrl: user.photo_url,
    };
  } catch {
    return {};
  }
}

/** 当前用户的"系统默认"显示名(不考虑用户自定义覆盖)。优先 first_name,其次 username,最后回退 '你' */
export function getTelegramDefaultDisplayName(): string {
  const info = parseTelegramUser(getRawInitData());
  return info.firstName?.trim() || info.username?.trim() || '你';
}

/** 当前 Telegram 用户头像 URL。旧客户端或隐私设置下可能为空。 */
export function getTelegramPhotoUrl(): string | undefined {
  return parseTelegramUser(getRawInitData()).photoUrl?.trim() || undefined;
}
