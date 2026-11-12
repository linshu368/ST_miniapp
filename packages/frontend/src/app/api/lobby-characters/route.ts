import {
  LOBBY_ROTATION_HEAD_SIZE,
  PublicLobbyHeadIdsSchema,
  fail,
  parseLobbySort,
} from '@miniapp/shared';
import * as Sentry from '@sentry/nextjs';

import { resolvePublicApiUrl } from '../../../../resolve-public-api-url.mjs';

// Resolve from Vercel's deployment context instead of reading the raw
// NEXT_PUBLIC_API_URL at runtime, where a stale project-wide Preview value can
// override the intended dev/PR target.
const BACKEND_URL = resolvePublicApiUrl();

export const revalidate = 0;
export const dynamic = 'force-dynamic';
const UPSTREAM_TIMEOUT_MS = 5_000;
const PUBLIC_LATEST_CACHE_CONTROL = 'public, max-age=60, s-maxage=60, stale-while-revalidate=60';

function recordProxyDuration(startedAt: number, outcome: string, status: number): void {
  try {
    Sentry.metrics.distribution('lobby.proxy.duration', performance.now() - startedAt, {
      unit: 'millisecond',
      attributes: {
        route: '/api/lobby-characters',
        outcome,
        status_class: `${Math.floor(status / 100)}xx`,
      },
    });
  } catch {
    // Observability must not change proxy behavior.
  }
}

function captureProxyError(error: unknown): void {
  try {
    Sentry.withScope((scope) => {
      scope.setTags({ service: 'frontend-next-proxy', route: '/api/lobby-characters' });
      scope.setFingerprint(['frontend-next-proxy', 'lobby-characters']);
      Sentry.captureException(error);
    });
  } catch {
    // Preserve the original upstream error.
  }
}

export async function GET(request: Request) {
  const startedAt = performance.now();
  // Only forward allowlisted sort/selection values to the backend.
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
    ) {
      recordProxyDuration(startedAt, 'bad_request', 400);
      return Response.json(
        { success: false, error: { code: 'BAD_REQUEST', message: '无效的角色列表' } },
        { status: 400 }
      );
    }
    selection = `&ids=${ids.data.join(',')}`;
  }

  const upstreamStartedAt = performance.now();
  const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${BACKEND_URL}/api/characters?sort=${sort}${limit}${selection}`, {
      cache: 'no-store',
      signal: AbortSignal.any([request.signal, deadline]),
    });
    const body = await upstream.text();
    const upstreamMs = performance.now() - upstreamStartedAt;
    recordProxyDuration(startedAt, upstream.ok ? 'ok' : 'http_error', upstream.status);
    const cacheControl =
      upstream.ok && sort === 'latest' && !limit && !selection
        ? PUBLIC_LATEST_CACHE_CONTROL
        : 'no-store, no-cache, must-revalidate';

    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
        'Cache-Control': cacheControl,
        'Server-Timing': `backend;dur=${upstreamMs.toFixed(1)}`,
      },
    });
  } catch (error) {
    const cancelled = request.signal.aborted;
    const timedOut = deadline.aborted;
    const status = cancelled ? 499 : timedOut ? 504 : 502;
    recordProxyDuration(
      startedAt,
      cancelled ? 'aborted' : timedOut ? 'timeout' : 'upstream_error',
      status
    );
    if (!cancelled) captureProxyError(error);
    // A thrown proxy error may become an HTML error page, hiding the recoverable
    // failure from the same JSON consumer used for successful catalogue responses.
    return Response.json(
      fail(
        cancelled ? 'REQUEST_ABORTED' : timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
        cancelled ? '请求已取消' : '角色列表暂时无法加载，请重试'
      ),
      { status, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
    );
  }
}
