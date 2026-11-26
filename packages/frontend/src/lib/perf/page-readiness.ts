import { getMetricDimensions } from './env-tags';

export function visitElapsed(current: {
  startedAt: number;
  hiddenMs: number;
  hiddenSince: number | null;
}): number {
  const now = performance.now();
  return Math.max(
    0,
    now -
      current.startedAt -
      current.hiddenMs -
      (current.hiddenSince === null ? 0 : now - current.hiddenSince)
  );
}

export function pageReadinessVersion(route: string, type: 'document' | 'spa' | 'mount') {
  if (route === '/creation/characters/new' || route === '/creation/characters/:id/edit')
    return 'creator_draft_ready_v2';
  return type === 'document'
    ? 'page_launch_v1'
    : type === 'spa'
      ? 'page_navigation_v1'
      : 'page_mount_v1';
}

export function visitAttributes(current: {
  route: string;
  navigationType: 'document' | 'spa' | 'mount';
  hiddenSince: number | null;
  wasHidden: boolean;
}) {
  return {
    route: current.route,
    navigation_type: current.navigationType,
    visibility:
      current.hiddenSince !== null ? 'background' : current.wasHidden ? 'mixed' : 'foreground',
    source_measurement_version: pageReadinessVersion(current.route, current.navigationType),
    ...getMetricDimensions(),
  };
}
