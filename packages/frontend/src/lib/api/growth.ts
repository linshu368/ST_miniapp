import type { RecordMiniappEntryData } from '@miniapp/shared';
import { apiClient } from './client';

export function recordMiniappEntry(sourceId?: string) {
  return apiClient<RecordMiniappEntryData>('/api/growth/miniapp-entry', {
    method: 'POST',
    body: JSON.stringify({ source_id: sourceId }),
  });
}
