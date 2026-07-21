import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, parseAppearanceMode } from './appearance-store';

describe('appearance persistence', () => {
  it('uses light mode for new users', () => {
    expect(DEFAULT_APPEARANCE).toBe('light');
  });

  it('accepts only persisted light and dark values', () => {
    expect(parseAppearanceMode('light')).toBe('light');
    expect(parseAppearanceMode('dark')).toBe('dark');
    expect(parseAppearanceMode('system')).toBeUndefined();
    expect(parseAppearanceMode(null)).toBeUndefined();
  });
});
