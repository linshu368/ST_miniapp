import {
  LOBBY_ROTATION_HEAD_SIZE,
  PublicLobbyHeadIdsSchema,
  parseLobbySort,
} from '@miniapp/shared';

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
  const params = new URL(request.url).searchParams;
  const sort = parseLobbySort(params.get('sort'));
  const limit =
    sort === 'recommended' && params.get('limit') === String(LOBBY_ROTATION_HEAD_SIZE)
      ? `&limit=${LOBBY_ROTATION_HEAD_SIZE}`
      : '';

  let selection = '';
  if (params.has('ids')) {
    const ids = PublicLobbyHeadIdsSchema.safeParse(params.get('ids'));
    if (
      !ids.success ||
      !limit ||
      params.get('sort') !== 'recommended' ||
      params.getAll('ids').length !== 1 ||
      params.getAll('sort').length !== 1 ||
      params.getAll('limit').length !== 1
    )
      return Response.json(
        { success: false, error: { code: 'BAD_REQUEST', message: '无效的角色列表' } },
        { status: 400 }
      );
    selection = `&ids=${ids.data.join(',')}`;
  }
  const upstream = await fetch(`${BACKEND_URL}/api/characters?sort=${sort}${limit}${selection}`, {
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
