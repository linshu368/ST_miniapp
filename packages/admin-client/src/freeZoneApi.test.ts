import { describe, expect, it } from 'vitest';
import { AdminFreeZoneStatusModelSchema } from '@miniapp/shared';
import {
  FREE_ZONE_STATUS_GROUPS,
  FREE_ZONE_STATUS_LABELS,
  freeZoneDelistText,
} from './freeZoneApi';

describe('free-zone status', () => {
  const model = AdminFreeZoneStatusModelSchema.parse({
    candidate_id: 'free-x',
    display_name: 'X',
    surplus_model: 'x',
    in_config: true,
    status: 'unlisted',
    providers: [],
    provider_since: null,
  });

  it('has one group per status', () => {
    expect(FREE_ZONE_STATUS_GROUPS.map((group) => group.key)).toEqual(
      Object.keys(FREE_ZONE_STATUS_LABELS)
    );
  });

  it('shows why a model was last delisted', () => {
    expect(freeZoneDelistText(model)).toBe('');
    const last_delist = { cause: null, at: '2026-11-24T08:00:00.000Z', reason: '运营手动下架' };
    expect(freeZoneDelistText({ ...model, last_delist })).toBe('运营手动下架');
  });
});
