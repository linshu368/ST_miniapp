const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL || process.env.ST_PUBLIC_PROXY_URL || 'http://localhost:3001';

export const revalidate = 300;
export const dynamic = 'force-dynamic';

export async function GET() {
  const upstream = await fetch(`${BACKEND_URL}/api/characters`, {
    next: { revalidate },
  });
  const body = await upstream.text();

  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
    },
  });
}
