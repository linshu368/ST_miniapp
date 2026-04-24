// 把 Telegram initData 相关的「取值 & 发送」封装在此。
// 业务代码要给后端带身份，只调用这里。
import { retrieveRawInitData } from '@telegram-apps/sdk-react';

/** 获取原始 initData 字符串（未签名/已签名由 Telegram 客户端决定）。
 *  在非 Telegram 环境或 SDK 未 init 时返回 undefined（不抛错）。
 */
export function getRawInitData(): string | undefined {
  if (process.env.NEXT_PUBLIC_USE_MOCK_INIT_DATA === '1') {
    // Local testing mock data
    // Contains a fake valid-looking user object, skipping signature hash verification is expected to fail on real backend
    // unless the backend bypasses signature check or we provide a valid hash.
    // For local dev without TG, we typically need the backend to accept mock auth.
    const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID || '123456789';

    const mockUser = {
      id: Number(mockUserId),
      first_name: 'Local',
      last_name: 'PM',
      username: `pm_${mockUserId}`,
      language_code: 'en',
      is_premium: true,
    };

    return (
      `query_id=mock_query_id&user=${encodeURIComponent(JSON.stringify(mockUser))}&auth_date=` +
      Math.floor(Date.now() / 1000) +
      '&hash=mock_hash'
    );
  }

  try {
    return retrieveRawInitData();
  } catch {
    return undefined;
  }
}

/** 统一放到 API 请求 header 的字段名。后端配套约定。 */
export const INIT_DATA_HEADER = 'X-Init-Data';
