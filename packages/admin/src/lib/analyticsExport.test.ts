import { describe, expect, it } from 'vitest';
import { analyticsRowsToCsv } from './analyticsExport';

describe('analyticsRowsToCsv', () => {
  it('exports the union of columns and escapes content', () => {
    const csv = analyticsRowsToCsv([
      { name: '角色"A"', value: 2 },
      { name: '第二行', detail: { ok: true } },
    ]);
    expect(csv).toContain('"name","value","detail"');
    expect(csv).toContain('"角色""A"""');
    expect(csv).toContain('"{""ok"":true}"');
  });

  it('returns an empty string for empty data', () => {
    expect(analyticsRowsToCsv([])).toBe('');
  });
});
