import { INVITE_START_PARAM_PREFIX } from '@miniapp/shared';

export const INVITE_BIND_PENDING_KEY = 'invite_bind_pending';
export const PAYMENT_RETURN_PREFIX = 'payment_return_';

/** Capture once before URL sanitizing or deferred modules can lose the launch context. */
export function getTelegramStartParam(rawInitData?: string, search?: string): string {
  const fromInitData = rawInitData
    ? new URLSearchParams(rawInitData).get('start_param')?.trim()
    : null;
  if (fromInitData) return fromInitData;
  const params = new URLSearchParams(
    search ?? (typeof window === 'undefined' ? '' : window.location.search)
  );
  return (
    params.get('startapp') ||
    params.get('start_param') ||
    params.get('tgWebAppStartParam') ||
    ''
  ).trim();
}

export function rememberInviteStartParam(startParam: string): void {
  if (!startParam.startsWith(INVITE_START_PARAM_PREFIX)) return;
  const code = startParam.slice(INVITE_START_PARAM_PREFIX.length);
  if (!/^[A-Za-z0-9]{8}$/.test(code)) return;
  try {
    sessionStorage.setItem(INVITE_BIND_PENDING_KEY, code);
  } catch {
    // Storage denial must not delay the current page or expose launch data in logs.
  }
}

const SENSITIVE_LAUNCH_PARAMS = new Set(['tgwebappdata', 'rawinitdata', 'xinitdata']);

function normalizeParamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function removeSensitiveParams(params: URLSearchParams): boolean {
  let changed = false;
  for (const key of Array.from(params.keys())) {
    if (!SENSITIVE_LAUNCH_PARAMS.has(normalizeParamName(key))) continue;
    params.delete(key);
    changed = true;
  }
  return changed;
}

export function stripSensitiveTelegramLaunchParams(urlValue: string): string {
  const url = new URL(urlValue);
  let changed = removeSensitiveParams(url.searchParams);

  const rawHash = url.hash.slice(1);
  if (rawHash) {
    const hashParams = new URLSearchParams(rawHash);
    if (removeSensitiveParams(hashParams)) {
      url.hash = hashParams.size > 0 ? hashParams.toString() : '';
      changed = true;
    }
  }

  return changed ? url.toString() : urlValue;
}

export function stripSensitiveTelegramLaunchParamsFromLocation(): void {
  if (typeof window === 'undefined') return;

  const sanitizedUrl = stripSensitiveTelegramLaunchParams(window.location.href);
  if (sanitizedUrl === window.location.href) return;
  window.history.replaceState(window.history.state, '', sanitizedUrl);
}
