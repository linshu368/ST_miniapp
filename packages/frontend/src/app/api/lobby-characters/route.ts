const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL || process.env.ST_PUBLIC_PROXY_URL || 'http://localhost:3001';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export async function GET() {
  const upstream = await fetch(`${BACKEND_URL}/api/characters`, {
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
