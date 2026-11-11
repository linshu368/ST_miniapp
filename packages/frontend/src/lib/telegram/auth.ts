// 把 Telegram initData 相关的「取值 & 发送」封装在此。
// 业务代码要给后端带身份，只调用这里。
import { retrieveRawInitData } from '@telegram-apps/sdk-react';

let cachedRawInitData: string | undefined;

/** 获取原始 initData 字符串（未签名/已签名由 Telegram 客户端决定）。
 *  在非 Telegram 环境或 SDK 未 init 时返回 undefined（不抛错）。
 */
export function getRawInitData(): string | undefined {
  if (cachedRawInitData) return cachedRawInitData;

  try {
    const data = retrieveRawInitData();
    if (data) {
      cachedRawInitData = data;
      return data;
    }
  } catch {
    // ignore
  }

  // Capture the original signed payload before launch-url cleanup. The server
  // remains the authority; never rebuild credentials from initDataUnsafe.
  if (typeof window !== 'undefined') {
    const host = window as Window & { Telegram?: { WebApp?: { initData?: unknown } } };
    const candidates = [
      host.Telegram?.WebApp?.initData,
      new URLSearchParams(window.location.hash.slice(1)).get('tgWebAppData'),
      new URLSearchParams(window.location.search).get('tgWebAppData'),
    ];
    for (const data of candidates) {
      if (typeof data === 'string' && data.trim()) {
        cachedRawInitData = data;
        return data;
      }
    }
  }

  return undefined;
}

/** 统一放到 API 请求 header 的字段名。后端配套约定。 */
export const INIT_DATA_HEADER = 'X-Init-Data';
