import { describe, expect, it } from 'vitest';
import { dramaSurveyCsv, summarizeDramaSurvey, type DramaSurveyRow } from './report.js';

const row = (overrides: Partial<DramaSurveyRow>): DramaSurveyRow => ({
  user_id: 'u',
  status: 'submitted',
  open_reasons: ['chat_only'],
  open_other_text: null,
  watch_reasons: ['slow_start'],
  watch_other_text: null,
  comment: null,
  platform: 'ios',
  engaged_dramas: 1,
  max_episode: 1,
  created_at: '2026-11-13T00:00:00Z',
  submitted_at: '2026-11-13T00:00:00Z',
  ...overrides,
});

describe('drama survey report', () => {
  const rows = [
    row({}),
    row({ watch_reasons: ['slow_start', 'boring_plot'], engaged_dramas: 3, max_episode: 5 }),
    row({ watch_reasons: ['boring_plot'], platform: 'android', comment: '无聊', max_episode: 2 }),
    row({ status: 'dismissed', open_reasons: [], watch_reasons: [], submitted_at: null }),
  ];
  const summary = summarizeDramaSurvey(rows);

  it('computes response rate and dismissal depth bias', () => {
    expect(summary.submitted).toBe(3);
    expect(summary.dismissed).toBe(1);
    expect(summary.responseRate).toBeCloseTo(0.75);
    expect(summary.lightShareSubmitted).toBeCloseTo(1 / 3);
    expect(summary.lightShareDismissed).toBe(1);
    expect(summary.comments).toBe(1);
  });

  it('uses respondents as the denominator for both questions', () => {
    const slow = summary.overall.watchReasons.find((item) => item.id === 'slow_start');
    const boring = summary.overall.watchReasons.find((item) => item.id === 'boring_plot');
    expect(slow).toMatchObject({ count: 2 });
    expect(slow?.share).toBeCloseTo(2 / 3);
    expect(boring?.count).toBe(2);
    expect(summary.overall.openReasons.find((item) => item.id === 'chat_only')?.share).toBe(1);
  });

  it('splits by platform and watch depth', () => {
    expect(summary.byPlatform.android.respondents).toBe(1);
    expect(summary.byPlatform.ios.respondents).toBe(2);
    expect(summary.byDepth.light.respondents).toBe(1);
    expect(summary.byDepth.deep.respondents).toBe(2);
  });

  it('exports labels and escapes free text', () => {
    const csv = dramaSurveyCsv([
      row({ watch_reasons: ['other'], watch_other_text: '说"太慢",真的', engaged_dramas: 4 }),
    ]);
    const [header, line] = csv.trim().split('\n');
    expect(header).toContain('user_id,status');
    expect(line).toContain('我来这里主要是聊天，不想看视频');
    expect(line).toContain(',4,');
    expect(line).toContain('"说""太慢"",真的"');
  });
});
