import { describe, expect, it } from 'vitest';
import { DramaTimingReportSchema } from './drama-timing.js';

// diagnostics.hls.manifestInline 是新增可选字段：旧报告必须继续通过，
// 新报告缺省/true/false 都要通过，非 boolean 必须拒绝（嵌套 strict）。

const BASE = {
  type: 'playback' as const,
  phase: 'final' as const,
  id: 'session-1',
  outcome: 'playing' as const,
  elapsedMs: 100,
  marks: {},
  stages: {},
  queries: [],
};

describe('DramaTimingReportSchema diagnostics.hls.manifestInline', () => {
  it('旧报告（缺省 manifestInline）仍兼容', () => {
    const result = DramaTimingReportSchema.safeParse({
      ...BASE,
      diagnostics: { hls: { entries: [], truncated: false } },
    });
    expect(result.success).toBe(true);
  });

  it('接受 true/false', () => {
    for (const manifestInline of [true, false]) {
      const result = DramaTimingReportSchema.safeParse({
        ...BASE,
        diagnostics: { hls: { entries: [], truncated: false, manifestInline } },
      });
      expect(result.success).toBe(true);
    }
  });

  it('拒绝非 boolean 的 manifestInline', () => {
    for (const manifestInline of ['true', 1, null]) {
      const result = DramaTimingReportSchema.safeParse({
        ...BASE,
        diagnostics: { hls: { entries: [], truncated: false, manifestInline } },
      });
      expect(result.success).toBe(false);
    }
  });

  it('不影响逐条 hls 记录的既有校验（嵌套 strict 不变）', () => {
    const result = DramaTimingReportSchema.safeParse({
      ...BASE,
      diagnostics: {
        hls: {
          entries: [{ kind: 'manifest', startMs: 0, endMs: 0 }],
          truncated: false,
          manifestInline: true,
        },
      },
    });
    expect(result.success).toBe(true);
    const rejected = DramaTimingReportSchema.safeParse({
      ...BASE,
      diagnostics: {
        hls: {
          entries: [{ kind: 'manifest', startMs: 0, endMs: 0, source: 'inline' }],
          truncated: false,
        },
      },
    });
    expect(rejected.success).toBe(false);
  });
});
