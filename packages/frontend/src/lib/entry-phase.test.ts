import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetEntryPhaseForTests,
  afterEntryBackground,
  afterEntryEnrich,
  ensureEntryPhaseWatching,
  markCriticalSettled,
} from './entry-phase';

describe('entry-phase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetEntryPhaseForTests();
  });
  afterEach(() => {
    __resetEntryPhaseForTests();
    vi.useRealTimers();
  });

  it('markCriticalSettled opens enrich then background after delay', async () => {
    const enrich = afterEntryEnrich();
    const background = afterEntryBackground();
    markCriticalSettled();
    await expect(enrich).resolves.toBeUndefined();

    let backgroundDone = false;
    void background.then(() => {
      backgroundDone = true;
    });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(backgroundDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(backgroundDone).toBe(true);
  });

  it('falls back to enrich after critical timeout', async () => {
    ensureEntryPhaseWatching();
    const enrich = afterEntryEnrich();
    let enrichDone = false;
    void enrich.then(() => {
      enrichDone = true;
    });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(enrichDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(enrichDone).toBe(true);
  });
});
