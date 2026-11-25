import { recordEngineeringEvent } from './grafana';
import { visitAttributes, visitElapsed } from './page-readiness';

export function recordNavigationBreakdown(
  current: Parameters<typeof visitElapsed>[0] &
    Parameters<typeof visitAttributes>[0] & { mountedElapsedMs: number | null },
  outcome: string
): void {
  if (
    outcome !== 'ready' ||
    current.navigationType !== 'spa' ||
    !['/chat/:id', '/chats'].includes(current.route) ||
    current.mountedElapsedMs === null
  )
    return;
  const total = visitElapsed(current);
  if (current.mountedElapsedMs > total) return;
  recordEngineeringEvent('page.navigation_breakdown', {
    ...visitAttributes(current),
    outcome: 'ready',
    source_measurement_version: 'page_navigation_breakdown_v1',
    navigation_to_mount_ms: current.mountedElapsedMs,
    mount_to_ready_ms: total - current.mountedElapsedMs,
  });
}
