/**
 * Next.js Route Handler — 同源代理 backend st-session 并返回 cookie 值。
 *
 * 流程：
 *   1. 从客户端请求中读取 X-Init-Data（TG 身份）
 *   2. 代理转发到 backend POST /api/bridge/st-session
 *   3. 将 st_cookie 原样返回给客户端（客户端用 document.cookie 写入）
 *   4. 顺带 Set-Cookie 过期请求里残留的旧 ST session（含 HttpOnly，JS 清不掉）
 *
 * 诊断：各阶段打 `[init-st-session]` 结构化日志（仅长度/计数/主机名，不含 cookie/initData 明文），
 * 未捕获异常也会落日志并返回带 stage 的 JSON 500，便于 Vercel Function / Sentry Replay 对照。
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  buildExpireSetCookieHeaders,
  isStSessionCookieName,
  parseCookiePairs,
  pickStSessionPairs,
} from '@/lib/bridge/st-cookies';

// Scheme Y (Vercel edge): NEXT_PUBLIC_API_URL may be empty when client-side calls
// go through same-origin Vercel rewrites. Fall back to the nginx gateway URL
// (ST_PUBLIC_PROXY_URL) so this server-side route handler can still reach backend.
const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL || process.env.ST_PUBLIC_PROXY_URL || 'http://localhost:3001';

type Stage =
  | 'start'
  | 'fetch_backend'
  | 'read_backend_error_body'
  | 'parse_backend_json'
  | 'build_expire_cookies'
  | 'append_set_cookie'
  | 'done';

function backendHost(): string {
  try {
    return new URL(BACKEND_URL).host;
  } catch {
    return 'invalid-backend-url';
  }
}

function summarizeRequestCookies(cookieHeader: string | null): {
  cookieHeaderBytes: number;
  cookiePairCount: number;
  stSessionCookieCount: number;
  stSessionCookieNames: string[];
} {
  const raw = cookieHeader ?? '';
  const pairs = parseCookiePairs(raw);
  const stNames = [
    ...new Set(pairs.map((p) => p.name).filter((name) => isStSessionCookieName(name))),
  ].sort();
  return {
    cookieHeaderBytes: raw.length,
    cookiePairCount: pairs.length,
    stSessionCookieCount: stNames.length,
    stSessionCookieNames: stNames.slice(0, 40),
  };
}

function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { errType: typeof err, errValue: String(err).slice(0, 500) };
  }
  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message.slice(0, 1000),
    stack: err.stack?.split('\n').slice(0, 12).join('\n'),
  };
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    out.causeName = cause.name;
    out.causeMessage = cause.message.slice(0, 500);
  } else if (cause != null) {
    out.cause = String(cause).slice(0, 500);
  }
  return out;
}

function log(stage: Stage, fields: Record<string, unknown> = {}): void {
  console.info(
    JSON.stringify({
      tag: 'init-st-session',
      stage,
      ts: new Date().toISOString(),
      ...fields,
    })
  );
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let stage: Stage = 'start';
  const cookieSummary = summarizeRequestCookies(request.headers.get('cookie'));
  const hasInitData = Boolean(request.headers.get('X-Init-Data'));

  log('start', {
    backendHost: backendHost(),
    hasInitData,
    ...cookieSummary,
  });

  try {
    stage = 'fetch_backend';
    const fetchStartedAt = Date.now();
    let backendRes: Response;
    try {
      backendRes = await fetch(`${BACKEND_URL}/api/bridge/st-session`, {
        method: 'POST',
        headers: {
          ...(hasInitData ? { 'X-Init-Data': request.headers.get('X-Init-Data')! } : {}),
        },
      });
    } catch (err) {
      log('fetch_backend', {
        ok: false,
        fetchMs: Date.now() - fetchStartedAt,
        totalMs: Date.now() - startedAt,
        ...serializeError(err),
      });
      throw err;
    }

    log('fetch_backend', {
      ok: backendRes.ok,
      backendStatus: backendRes.status,
      fetchMs: Date.now() - fetchStartedAt,
      contentType: backendRes.headers.get('content-type'),
    });

    if (!backendRes.ok) {
      stage = 'read_backend_error_body';
      const text = await backendRes.text();
      log('read_backend_error_body', {
        backendStatus: backendRes.status,
        bodyBytes: text.length,
        bodyPreview: text.slice(0, 300),
        totalMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { success: false, error: { message: text, stage: 'backend_non_ok' } },
        { status: backendRes.status }
      );
    }

    stage = 'parse_backend_json';
    const body = (await backendRes.json()) as {
      success: boolean;
      data: { st_url: string; st_cookie: string; is_new_user: boolean };
    };

    const stCookieBytes = body.data?.st_cookie?.length ?? 0;
    const keepNames = pickStSessionPairs(body.data?.st_cookie ?? '').map((p) => p.name);
    log('parse_backend_json', {
      success: body.success,
      isNewUser: body.data?.is_new_user ?? null,
      stCookieBytes,
      keepNameCount: keepNames.length,
      keepNames,
    });

    if (!body.success || !body.data?.st_cookie) {
      log('parse_backend_json', {
        outcome: 'no_cookie',
        totalMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { success: false, error: { message: 'st-session returned no cookie', stage: 'no_cookie' } },
        { status: 502 }
      );
    }

    stage = 'build_expire_cookies';
    const {
      headers: expireHeaders,
      orphanTotal,
      orphanExpired,
    } = buildExpireSetCookieHeaders(request.headers.get('cookie'), keepNames);
    const expireHeaderBytes = expireHeaders.reduce((sum, h) => sum + h.length, 0);
    log('build_expire_cookies', {
      expireHeaderCount: expireHeaders.length,
      expireHeaderBytes,
      orphanTotal,
      orphanExpired,
      orphanRemaining: orphanTotal - orphanExpired,
    });

    stage = 'append_set_cookie';
    const response = NextResponse.json(body);
    for (const setCookie of expireHeaders) {
      response.headers.append('Set-Cookie', setCookie);
    }

    stage = 'done';
    log('done', {
      totalMs: Date.now() - startedAt,
      expireHeaderCount: expireHeaders.length,
      expireHeaderBytes,
      orphanTotal,
      orphanExpired,
      orphanRemaining: orphanTotal - orphanExpired,
      cookieHeaderBytes: cookieSummary.cookieHeaderBytes,
      stSessionCookieCount: cookieSummary.stSessionCookieCount,
    });
    return response;
  } catch (err) {
    const payload = {
      tag: 'init-st-session',
      stage,
      totalMs: Date.now() - startedAt,
      backendHost: backendHost(),
      hasInitData,
      ...cookieSummary,
      ...serializeError(err),
    };
    console.error(JSON.stringify({ ...payload, level: 'error' }));
    return NextResponse.json(
      {
        success: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          stage,
          name: err instanceof Error ? err.name : typeof err,
        },
      },
      { status: 500 }
    );
  }
}
