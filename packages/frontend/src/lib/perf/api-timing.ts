import {
  isEngineeringTelemetryEnabled,
  recordEngineeringEvent,
  recordEngineeringMeasurement,
} from './grafana';
import type { ApiAttemptTiming } from '@/lib/api/client';

/** Finite groups only: short IDs and query strings must never reach the exporter. */
export function apiRouteGroup(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  if (pathname === '/api/characters') return 'characters';
  if (pathname === '/api/lobby-characters') return 'lobby_characters';
  if (pathname === '/api/characters/latest-badge' || pathname === '/api/characters/latest-seen')
    return 'character_activity';
  if (pathname === '/api/characters/recommendation') return 'character_recommendation';
  if (pathname === '/api/characters/social') return 'character_social';
  if (/^\/api\/characters\/[^/]+\/(?:social|like|comments)(?:\/|$)/.test(pathname))
    return 'character_social';
  if (/^\/api\/characters\/[^/]+$/.test(pathname)) return 'character_detail';
  if (pathname.startsWith('/api/creator/')) return 'creator';
  if (pathname.startsWith('/api/creators/')) return 'creator_public';
  if (pathname.startsWith('/api/character-wishes')) return 'character_wishes';
  if (pathname === '/api/favorites' || pathname === '/api/favorites/ids') return 'favorites';
  if (pathname.startsWith('/api/favorites/')) return 'favorites';
  if (pathname === '/api/v1/conversations') return 'conversations';
  if (/^\/api\/v1\/conversations\/[^/]+$/.test(pathname)) return 'conversation_detail';
  if (pathname.startsWith('/api/v1/conversations/')) return 'conversation_turn';
  if (pathname === '/api/dramas') return 'dramas';
  // 固定地址的 POST 取址必须在 drama_detail 之前判断，否则 /api/dramas/play 会被当成剧详情。
  if (pathname === '/api/dramas/play') return 'drama_playback';
  if (/^\/api\/dramas\/[^/]+$/.test(pathname)) return 'drama_detail';
  if (/^\/api\/dramas\/[^/]+\/(?:play|playback)$/.test(pathname)) return 'drama_playback';
  if (pathname.startsWith('/api/dramas/')) return 'drama_social';
  const groups: ReadonlyArray<readonly [string, string]> = [
    ['/api/v1/images/', 'images'],
    ['/api/v1/voice/', 'voice'],
    ['/api/image-plaza/', 'image_plaza'],
    ['/api/v1/models/', 'models'],
    ['/api/v1/generation-config', 'settings'],
    ['/api/users/', 'settings'],
    ['/api/wallet/', 'wallet'],
    ['/api/payment/', 'payment'],
    ['/api/vip/', 'vip'],
    ['/api/notifications', 'notifications'],
    ['/api/support/', 'support'],
    ['/api/community/', 'community'],
    ['/api/invite/', 'invite'],
    ['/api/growth/', 'growth'],
    ['/api/v1/text-postprocess/', 'text_postprocess'],
  ];
  return groups.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? 'other';
}

export function shouldObserveApiTiming(path: string): boolean {
  // Existing receipt/telemetry uploads are diagnostics, not user requests; avoid feedback loops.
  return !path.startsWith('/api/telemetry/') && isEngineeringTelemetryEnabled();
}

function attributes(path: string, method: string, timing: ApiAttemptTiming) {
  return {
    api_route: apiRouteGroup(path),
    method,
    outcome: timing.outcome ?? 'error',
    status_class: timing.status ? `${Math.floor(timing.status / 100)}xx` : 'network',
  };
}

/** Same monotonic clock as the existing onAttempt callback; no new request owner. */
export function recordApiAttempt(
  path: string,
  method: string,
  timing: ApiAttemptTiming,
  attempt: number
): void {
  const end = timing.endedAt;
  if (end === undefined) return;
  const tags = {
    ...attributes(path, method, timing),
    attempt,
    source_measurement_version: 'api_attempt_v1',
  };
  if (timing.dispatchedAt !== undefined) {
    recordEngineeringMeasurement('api.queue', timing.dispatchedAt - timing.queuedAt, tags);
    if (timing.headersAt !== undefined) {
      recordEngineeringMeasurement('api.headers', timing.headersAt - timing.dispatchedAt, tags);
      recordEngineeringMeasurement('api.body', end - timing.headersAt, tags);
    }
  }
  if (timing.upstreamMs !== undefined) {
    recordEngineeringMeasurement('api.upstream', timing.upstreamMs, tags);
  }
}

export function recordApiTotal(
  path: string,
  method: string,
  startedAt: number,
  timing: ApiAttemptTiming,
  attempts: number
): void {
  const tags = {
    ...attributes(path, method, timing),
    attempts,
    source_measurement_version: 'api_logical_v1',
  };
  recordEngineeringMeasurement('api.total', performance.now() - startedAt, tags);
  recordEngineeringEvent('api.terminal', tags);
}
