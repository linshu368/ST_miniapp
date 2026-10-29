import { parseLobbySort } from '@miniapp/shared';

import { resolvePublicApiUrl } from '../../../../resolve-public-api-url.mjs';

// Resolve from Vercel's deployment context instead of reading the raw
// NEXT_PUBLIC_API_URL at runtime, where a stale project-wide Preview value can
// override the intended dev/PR target.
const BACKEND_URL = resolvePublicApiUrl();

export const revalidate = 0;
export const dynamic = 'force-dynamic';
const UPSTREAM_TIMEOUT_MS = 5_000;

export async function GET(request: Request) {
  // 只透传白名单内的排序值，避免把任意查询串转发给后端。
  const sort = parseLobbySort(new URL(request.url).searchParams.get('sort'));

  const upstream = await fetch(`${BACKEND_URL}/api/characters?sort=${sort}`, {
    cache: 'no-store',
    // 浏览器离页与代理预算任一先到都终止 Railway 上游，避免旧大厅请求继续占连接。
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
  });
  const body = await upstream.text();

  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
