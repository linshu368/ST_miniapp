// 把 Telegram initData 相关的「取值 & 发送」封装在此。
// 业务代码要给后端带身份，只调用这里。
import { retrieveRawInitData } from '@telegram-apps/sdk-react';

/** 获取原始 initData 字符串（未签名/已签名由 Telegram 客户端决定）。
 *  在非 Telegram 环境或 SDK 未 init 时返回 undefined（不抛错）。
 */
export function getRawInitData(): string | undefined {
  try {
    const data = retrieveRawInitData();
    if (data) return data;
  } catch {
    // ignore
  }

  // Fallback for local development if MOCK_AUTH is used
  if (typeof window !== 'undefined') {
    const urlParams = new URLSearchParams(window.location.search);
    const tgWebAppData = urlParams.get('tgWebAppData');
    if (tgWebAppData) return tgWebAppData;
  }

  return undefined;
}

/** 统一放到 API 请求 header 的字段名。后端配套约定。 */
export const INIT_DATA_HEADER = 'X-Init-Data';
