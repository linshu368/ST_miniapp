/**
 * backend / lib / telegram-links.ts
 *
 * 拼装 t.me MiniApp 深链（https://t.me/{botUsername}/{shortName}?startapp=...）。
 *
 * bot username 通过 getMe 现取并进程内缓存（与 payment.ts 回跳的做法一致）；
 * MiniApp 短名走 MINIAPP_SHORT_NAME 环境变量，测试/生产当前均为 'app'（也是缺省值）。
 */

import { config } from '../platform/config.js';

let telegramBotUsernamePromise: Promise<string | null> | null = null;

export function resolveTelegramBotUsername(): Promise<string | null> {
  if (!config.telegramBotToken) return Promise.resolve(null);
  telegramBotUsernamePromise ??= fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/getMe`,
    { signal: AbortSignal.timeout(5_000) }
  )
    .then(
      (response) =>
        response.json() as Promise<{
          ok?: boolean;
          result?: { username?: string };
        }>
    )
    .then((payload) => (payload.ok ? (payload.result?.username ?? null) : null))
    .catch(() => {
      // 失败不缓存，下次调用重试。
      telegramBotUsernamePromise = null;
      return null;
    });
  return telegramBotUsernamePromise;
}

export function resolveMiniappShortName(): string {
  const value = (process.env.MINIAPP_SHORT_NAME || 'app').replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : 'app';
}

/**
 * 拼 MiniApp 深链。bot username 不可用（如本地 MOCK_AUTH 无 bot token）时返回 null，
 * 调用方自行降级。
 */
export async function buildMiniappDeepLink(startParam: string): Promise<string | null> {
  const botUsername = await resolveTelegramBotUsername();
  if (!botUsername) return null;
  const url = new URL(`https://t.me/${botUsername}/${resolveMiniappShortName()}`);
  url.searchParams.set('startapp', startParam);
  return url.toString();
}
