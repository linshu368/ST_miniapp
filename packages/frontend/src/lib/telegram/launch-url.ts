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
