import type { ReplaySdkFailureCode } from '@miniapp/shared';

export const POSTHOG_KEY_ENV = 'NEXT_PUBLIC_POSTHOG_KEY';
export const POSTHOG_HOST_ENV = 'NEXT_PUBLIC_POSTHOG_HOST';

/** 与官方 Next.js Session Replay 安装文档一致；其后 snapshot 会默认打开 network body。 */
export const POSTHOG_JS_DEFAULTS = '2026-05-30' as const;

export type PostHogBrowserEnv = {
  key: string | undefined;
  host: string | undefined;
};

export type PostHogConfigResolution =
  | { ok: true; key: string; host: string }
  | { ok: false; failureCode: Extract<ReplaySdkFailureCode, 'missing_config' | 'invalid_host'> };

/**
 * Next.js 只把静态成员访问 `process.env.NEXT_PUBLIC_*` 内联进浏览器包。
 * 经 `env = process.env` 再读属性时，Preview/生产 bundle 里永远是 undefined，
 * adapter 会走 missing_config no-op，Session Replay 不会初始化。
 */
export function readPostHogBrowserEnv(env?: PostHogBrowserEnv): PostHogBrowserEnv {
  const key = env ? env.key : process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = env ? env.host : process.env.NEXT_PUBLIC_POSTHOG_HOST;
  return {
    key: key?.trim() || undefined,
    host: host?.trim() || undefined,
  };
}

export function resolvePostHogConfig(
  env: PostHogBrowserEnv = readPostHogBrowserEnv()
): PostHogConfigResolution {
  if (!env.key || !env.host) {
    return { ok: false, failureCode: 'missing_config' };
  }
  if (!isAllowedPostHogHost(env.host)) {
    return { ok: false, failureCode: 'invalid_host' };
  }
  return { ok: true, key: env.key, host: env.host };
}

export function isAllowedPostHogHost(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
