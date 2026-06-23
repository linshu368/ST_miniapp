import { describe, it, expect } from 'vitest';
import { deriveStHandle, parseTgIdFromHandle, isStBridgeHandle } from '../st-bridge/handle.js';

describe('deriveStHandle', () => {
  it('should derive handle from numeric tg_id', () => {
    expect(deriveStHandle('672913845')).toBe('tg-672913845');
  });

  it('should handle very large tg_id', () => {
    expect(deriveStHandle('9999999999999')).toBe('tg-9999999999999');
  });

  it('should handle single digit tg_id', () => {
    expect(deriveStHandle('1')).toBe('tg-1');
  });

  it('should trim whitespace', () => {
    expect(deriveStHandle(' 672913845 ')).toBe('tg-672913845');
  });

  it('should throw on empty string', () => {
    expect(() => deriveStHandle('')).toThrow('non-empty string');
  });

  it('should throw on non-numeric string', () => {
    expect(() => deriveStHandle('abc')).toThrow('numeric string');
  });

  it('should throw on mixed alphanumeric', () => {
    expect(() => deriveStHandle('123abc')).toThrow('numeric string');
  });

  it('should throw on negative number', () => {
    expect(() => deriveStHandle('-123')).toThrow('numeric string');
  });

  it('should throw on decimal', () => {
    expect(() => deriveStHandle('1.5')).toThrow('numeric string');
  });
});

describe('parseTgIdFromHandle', () => {
  it('should extract tg_id from valid handle', () => {
    expect(parseTgIdFromHandle('tg-672913845')).toBe('672913845');
  });

  it('should return null for non-bridge handle', () => {
    expect(parseTgIdFromHandle('default-user')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseTgIdFromHandle('')).toBeNull();
  });

  it('should return null for tg- prefix with non-numeric suffix', () => {
    expect(parseTgIdFromHandle('tg-abc')).toBeNull();
  });

  it('should return null for bare prefix', () => {
    expect(parseTgIdFromHandle('tg-')).toBeNull();
  });
});

describe('isStBridgeHandle', () => {
  it('should return true for valid bridge handle', () => {
    expect(isStBridgeHandle('tg-672913845')).toBe(true);
  });

  it('should return false for ST default user', () => {
    expect(isStBridgeHandle('default-user')).toBe(false);
  });

  it('should return false for arbitrary handle', () => {
    expect(isStBridgeHandle('testuser')).toBe(false);
  });
});
