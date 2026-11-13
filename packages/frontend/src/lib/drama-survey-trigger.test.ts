import { describe, expect, it } from 'vitest';
import {
  reachedDramaSurveyRound,
  readDramaSurveyDone,
  shuffled,
  writeDramaSurveyDone,
} from './drama-survey-trigger';

const rounds = (count: number) =>
  Array.from({ length: count }, () => [{ role: 'user' }, { role: 'assistant' }]).flat();
const completed = { wasGenerating: true, generating: false, failed: false };

describe('drama survey trigger', () => {
  it('fires when a reply completes in a conversation with at least 4 rounds', () => {
    expect(reachedDramaSurveyRound({ ...completed, messages: rounds(4) })).toBe(true);
    expect(reachedDramaSurveyRound({ ...completed, messages: rounds(12) })).toBe(true);
    expect(reachedDramaSurveyRound({ ...completed, messages: rounds(3) })).toBe(false);
  });

  it('only fires on the completion edge of a successful reply', () => {
    const messages = rounds(5);
    expect(reachedDramaSurveyRound({ ...completed, wasGenerating: false, messages })).toBe(false);
    expect(reachedDramaSurveyRound({ ...completed, generating: true, messages })).toBe(false);
    expect(reachedDramaSurveyRound({ ...completed, failed: true, messages })).toBe(false);
    expect(
      reachedDramaSurveyRound({ ...completed, messages: [...messages, { role: 'user' }] })
    ).toBe(false);
  });

  it('remembers done per user scope', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
    expect(readDramaSurveyDone('1', storage)).toBe(false);
    writeDramaSurveyDone('1', storage);
    expect(readDramaSurveyDone('1', storage)).toBe(true);
    expect(readDramaSurveyDone('2', storage)).toBe(false);
    expect(readDramaSurveyDone('1', null)).toBe(false);
  });

  it('shuffles without losing or duplicating options', () => {
    const items = ['a', 'b', 'c', 'd'];
    const result = shuffled(items, () => 0);
    expect([...result].sort()).toEqual(items);
    expect(items).toEqual(['a', 'b', 'c', 'd']);
  });
});
