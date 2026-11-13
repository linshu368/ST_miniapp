import { describe, expect, it } from 'vitest';
import {
  DismissDramaSurveyRequestSchema,
  SubmitDramaSurveyRequestSchema,
} from '../api/drama-survey';

const engagement = { engaged_dramas: 2, max_episode: 3 };
const valid = { open_reasons: ['chat_only'], watch_reasons: ['slow_start'], engagement };
const parse = (body: unknown) => SubmitDramaSurveyRequestSchema.safeParse(body);

describe('drama survey request', () => {
  it('requires at least one answer for both Q2a and Q2b', () => {
    expect(parse(valid).success).toBe(true);
    expect(parse({ ...valid, open_reasons: [] }).success).toBe(false);
    expect(parse({ ...valid, watch_reasons: [] }).success).toBe(false);
    expect(parse({ watch_reasons: ['slow_start'], engagement }).success).toBe(false);
  });

  it('keeps each question to its own options, distinct, at most two', () => {
    expect(parse({ ...valid, open_reasons: ['slow_start'] }).success).toBe(false);
    expect(parse({ ...valid, watch_reasons: ['chat_only'] }).success).toBe(false);
    expect(parse({ ...valid, watch_reasons: ['stutter', 'stutter'] }).success).toBe(false);
    expect(
      parse({ ...valid, watch_reasons: ['stutter', 'boring_plot', 'ai_visuals'] }).success
    ).toBe(false);
  });

  it('allows other text only with the other option of the same question', () => {
    expect(parse({ ...valid, open_other_text: '太忙' }).success).toBe(false);
    expect(parse({ ...valid, open_reasons: ['other'], open_other_text: '太忙' }).success).toBe(
      true
    );
    expect(parse({ ...valid, open_reasons: ['other'], watch_other_text: '慢' }).success).toBe(
      false
    );
  });

  it('requires real engagement depth and rejects unknown fields', () => {
    expect(parse({ ...valid, engagement: { engaged_dramas: 0, max_episode: 1 } }).success).toBe(
      false
    );
    expect(parse({ ...valid, credits: 999 }).success).toBe(false);
    expect(parse({ ...valid, comment: 'x'.repeat(501) }).success).toBe(false);
    expect(DismissDramaSurveyRequestSchema.safeParse({ engagement }).success).toBe(true);
    expect(DismissDramaSurveyRequestSchema.safeParse({}).success).toBe(false);
  });
});
