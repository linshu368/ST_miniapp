/**
 * Next.js Route Handler — 同源代理 backend st-session 并返回 cookie 值。
 *
 * 流程：
 *   1. 从客户端请求中读取 X-Init-Data（TG 身份）
 *   2. 代理转发到 backend POST /api/bridge/st-session
 *   3. 将 st_cookie 原样返回给客户端（客户端用 document.cookie 写入）
 */

import { NextRequest, NextResponse } from 'next/server';

// Scheme Y (Vercel edge): NEXT_PUBLIC_API_URL may be empty when client-side calls
// go through same-origin Vercel rewrites. Fall back to the nginx gateway URL
// (ST_PUBLIC_PROXY_URL) so this server-side route handler can still reach backend.
const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL || process.env.ST_PUBLIC_PROXY_URL || 'http://localhost:3001';

export async function POST(request: NextRequest) {
  const initData = request.headers.get('X-Init-Data') ?? '';

  const backendRes = await fetch(`${BACKEND_URL}/api/bridge/st-session`, {
    method: 'POST',
    headers: {
      ...(initData ? { 'X-Init-Data': initData } : {}),
    },
  });

  if (!backendRes.ok) {
    const text = await backendRes.text();
    return NextResponse.json(
      { success: false, error: { message: text } },
      { status: backendRes.status }
    );
  }

  const body = (await backendRes.json()) as {
    success: boolean;
    data: { st_url: string; st_cookie: string; is_new_user: boolean };
  };

  if (!body.success || !body.data?.st_cookie) {
    return NextResponse.json(
      { success: false, error: { message: 'st-session returned no cookie' } },
      { status: 502 }
    );
  }

  return NextResponse.json(body);
}
