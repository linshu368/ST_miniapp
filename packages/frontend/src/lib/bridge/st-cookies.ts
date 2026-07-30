/**
 * ST session cookie helpers.
 *
 * SillyTavern cookie-session names cookies as `session-<hostnameHash>` (+ `.sig`).
 * When the ST container hostname changes across deploys, old names are never
 * overwritten and accumulate on long-lived preview hosts until nginx rejects
 * the request with `400 Request Header Or Cookie Too Large`.
 */

/** ST session cookie: `session`, `session.sig`, `session-<8hex>`, `session-<8hex>.sig` */
export const ST_SESSION_COOKIE_RE = /^session(-[0-9a-f]{8})?(\.sig)?$/i;

export function isStSessionCookieName(name: string): boolean {
  return ST_SESSION_COOKIE_RE.test(name);
}

/** Parse `name=value` pairs from a Cookie / st_cookie header string. */
export function parseCookiePairs(header: string): Array<{ name: string; pair: string }> {
  const out: Array<{ name: string; pair: string }> = [];
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out.push({ name: trimmed.slice(0, eq), pair: trimmed });
  }
  return out;
}

/** Whitelist ST session pairs from backend `st_cookie`. */
export function pickStSessionPairs(stCookie: string): Array<{ name: string; pair: string }> {
  return parseCookiePairs(stCookie).filter(({ name }) => isStSessionCookieName(name));
}

/**
 * Expire a cookie under common attribute combinations.
 * Attribute mismatch leaves a duplicate jar entry, so try Lax / None / Partitioned.
 */
export function expireDocumentCookie(name: string): void {
  const base = `${name}=; Max-Age=0; Path=/`;
  document.cookie = base;
  document.cookie = `${base}; SameSite=Lax`;
  document.cookie = `${base}; SameSite=None; Secure`;
  document.cookie = `${base}; SameSite=None; Secure; Partitioned`;
}

/** Collect ST session cookie names currently visible to JS (`document.cookie`). */
export function listDocumentStSessionCookieNames(): string[] {
  const names = new Set<string>();
  for (const { name } of parseCookiePairs(document.cookie)) {
    if (isStSessionCookieName(name)) names.add(name);
  }
  return [...names];
}

/**
 * Clear stale ST session cookies (JS-visible) then write only whitelisted pairs
 * with attributes that work inside Telegram's partitioned / embedded WebView.
 */
export function writeStCookies(cookieHeader: string): void {
  const nextPairs = pickStSessionPairs(cookieHeader);
  const toClear = new Set<string>([
    ...listDocumentStSessionCookieNames(),
    ...nextPairs.map((p) => p.name),
  ]);

  for (const name of toClear) {
    expireDocumentCookie(name);
  }

  // Telegram Mini App 运行在受限/被分区（partitioned）的 WebView / 三方 iframe 上下文
  // （尤其 Telegram Web 把小程序套在 web.telegram.org 的 iframe 里）。此时 SameSite=Lax
  // 的 cookie 会被当作三方 cookie 拦截/隔离，导致 ST iframe(/tavern/) 请求不带 session
  // → ST 302 到 /login，对话页空白。改用 SameSite=None; Secure 让 cookie 在嵌入上下文也能
  // 携带；Partitioned(CHIPS) 兼容"三方 cookie 分区"的浏览器（不支持该属性的会忽略，
  // 退化为 SameSite=None; Secure，同源请求照常携带，无回归风险）。
  for (const { pair } of nextPairs) {
    document.cookie = `${pair}; Path=/; SameSite=None; Secure; Partitioned`;
  }
}

/**
 * Build Set-Cookie lines that expire orphan ST session cookies on the request.
 * Needed because HttpOnly cookies (set by ST via rewrite) cannot be cleared from JS.
 */
export function buildExpireSetCookieHeaders(
  requestCookieHeader: string | null,
  keepNames: Iterable<string>
): string[] {
  const keep = new Set(keepNames);
  const orphans = new Set<string>();
  for (const { name } of parseCookiePairs(requestCookieHeader ?? '')) {
    if (isStSessionCookieName(name) && !keep.has(name)) {
      orphans.add(name);
    }
  }

  const headers: string[] = [];
  for (const name of orphans) {
    headers.push(`${name}=; Path=/; Max-Age=0`);
    headers.push(`${name}=; Path=/; Max-Age=0; SameSite=Lax`);
    headers.push(`${name}=; Path=/; Max-Age=0; SameSite=None; Secure`);
    headers.push(`${name}=; Path=/; Max-Age=0; SameSite=None; Secure; Partitioned`);
  }
  return headers;
}
