import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG_STALE_TIME_MS, shouldRefreshModelCatalog } from './model-cache-policy';

describe('model catalog refresh policy', () => {
  it('refreshes missing and older-than-five-minute data only', () => {
    const now = 1_000_000;
    expect(shouldRefreshModelCatalog(0, now)).toBe(true);
    expect(shouldRefreshModelCatalog(now - MODEL_CATALOG_STALE_TIME_MS, now)).toBe(false);
    expect(shouldRefreshModelCatalog(now - MODEL_CATALOG_STALE_TIME_MS - 1, now)).toBe(true);
  });
});
