import { describe, expect, it } from 'vitest';

import { isInstructionSlotEnabled } from './chat-generation-settings-state';

describe('isInstructionSlotEnabled', () => {
  it('keeps explicit server values and defaults a missing slot to enabled', () => {
    expect(isInstructionSlotEnabled(true)).toBe(true);
    expect(isInstructionSlotEnabled(false)).toBe(false);
    expect(isInstructionSlotEnabled(undefined)).toBe(true);
  });
});
