import { parseLobbySort } from '@miniapp/shared';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // 只透传白名单内的排序值，避免把任意查询串转发给后端。
  const sort = parseLobbySort(new URL(request.url).searchParams.get('sort'));

  const upstream = await fetch(`${BACKEND_URL}/api/characters?sort=${sort}`, {
    cache: 'no-store',
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
