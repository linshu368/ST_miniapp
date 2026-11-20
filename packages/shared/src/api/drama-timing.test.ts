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

// diagnostics.hls.events / eventsTruncated / eventCounts 是快进诊断新增的可选字段。
// 后端按 strict schema 校验，前端只能在后端部署本契约后才开始带这些字段。
describe('DramaTimingReportSchema diagnostics.hls.events', () => {
  const event = {
    atMs: 120.5,
    type: 'frag_loading' as const,
    track: 'main' as const,
    sn: 3,
    level: 2,
  };
  const counts = { fragLoading: 30, emergencyAborted: 0, levelSwitching: 1, error: 2 };
  const parse = (hls: Record<string, unknown>) =>
    DramaTimingReportSchema.safeParse({
      ...BASE,
      diagnostics: { hls: { entries: [], truncated: false, ...hls } },
    }).success;

  it('旧报告（缺省三项）仍兼容', () => {
    expect(parse({})).toBe(true);
  });

  it('接受 4 类事件、错误标识与计数', () => {
    expect(
      parse({
        events: [
          event,
          { atMs: 130, type: 'frag_emergency_aborted', track: 'main', sn: 3, level: 2 },
          { atMs: -5, type: 'level_switching', level: 0 },
          { atMs: 140, type: 'error', detail: 'bufferAppendError', fatal: false, track: 'audio' },
        ],
        eventsTruncated: true,
        eventCounts: counts,
      })
    ).toBe(true);
  });

  it('事件最多 24 条', () => {
    expect(parse({ events: Array.from({ length: 24 }, () => event) })).toBe(true);
    expect(parse({ events: Array.from({ length: 25 }, () => event) })).toBe(false);
  });

  it('detail 只接受 hls.js 驼峰标识符，不接受文案、URL 或超长串', () => {
    for (const detail of [
      'frag load error',
      'https://x.test/seg.m4s',
      'fragLoadError2',
      '',
      'a'.repeat(49),
    ]) {
      expect(parse({ events: [{ ...event, type: 'error', detail }] })).toBe(false);
    }
  });

  it('事件与计数都是 strict：未知类型、多余字段、缺计数项都拒绝', () => {
    expect(parse({ events: [{ ...event, type: 'frag_loaded' }] })).toBe(false);
    expect(parse({ events: [{ ...event, url: 'x' }] })).toBe(false);
    expect(parse({ events: [{ ...event, level: 65 }] })).toBe(false);
    expect(parse({ eventCounts: { ...counts, other: 1 } })).toBe(false);
    expect(parse({ eventCounts: { fragLoading: 1, emergencyAborted: 0, levelSwitching: 0 } })).toBe(
      false
    );
  });
});

// diagnostics.hls.prefetch.source 新增非封面入口的来源；前端只能在后端部署本契约后才开始上报。
describe('DramaTimingReportSchema diagnostics.hls.prefetch.source', () => {
  const parse = (source: unknown) =>
    DramaTimingReportSchema.safeParse({
      ...BASE,
      diagnostics: {
        hls: {
          entries: [],
          truncated: false,
          prefetch: { source, playlists: 2, bytes: 1, discardedCount: 0, discardedBytes: 0 },
        },
      },
    }).success;

  it('接受封面与非封面入口的全部来源', () => {
    for (const source of [
      'visible_cover',
      'press_cover',
      'intent',
      'recent',
      'next_episode',
      'next_drama',
      'press_episode',
    ]) {
      expect(parse(source)).toBe(true);
    }
  });

  it('拒绝未知来源', () => {
    expect(parse('next_feed')).toBe(false);
  });
});
