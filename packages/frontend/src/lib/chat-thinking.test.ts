import { describe, expect, it } from 'vitest';
import { MAX_CONVERSATION_REASONING_LENGTH } from '@miniapp/shared';
import {
  appendMessageThinking,
  messageThinkingKey,
  MAX_LOCAL_THINKING_MESSAGES,
  readThinkingPreference,
  writeThinkingPreference,
  thinkingDisclosurePhase,
  thinkingDisclosureOpen,
  type MessageThinkingMap,
} from './chat-thinking';

describe('ephemeral thinking', () => {
  it('isolates sessions and revisions without changing message body', () => {
    const a = { session_id: 's1', id: 'a', revision: 0 };
    const original = { ...a, content: 'answer' };
    let entries = appendMessageThinking({}, messageThinkingKey(a), 'first');
    entries = appendMessageThinking(
      entries,
      messageThinkingKey({ ...a, revision: 1 }),
      'regenerated'
    );
    entries = appendMessageThinking(
      entries,
      messageThinkingKey({ ...a, session_id: 's2' }),
      'other'
    );
    expect(Object.values(entries)).toEqual(['first', 'regenerated', 'other']);
    expect(original.content).toBe('answer');
  });

  it('bounds message count and text, never persisting reasoning', () => {
    let entries: MessageThinkingMap = {};
    for (let i = 0; i < MAX_LOCAL_THINKING_MESSAGES + 1; i++)
      entries = appendMessageThinking(entries, `m${i}`, 'x');
    expect(Object.keys(entries)).toHaveLength(MAX_LOCAL_THINKING_MESSAGES);
    expect(entries.m0).toBeUndefined();
    entries = appendMessageThinking(
      entries,
      'long',
      '中'.repeat(MAX_CONVERSATION_REASONING_LENGTH + 10)
    );
    expect(entries.long).toHaveLength(MAX_CONVERSATION_REASONING_LENGTH);
    expect(appendMessageThinking(entries, 'long', 'ignored')).toBe(entries);
  });

  it('starts expanded while thinking, folds on answer, and respects later manual expansion', () => {
    const thinking = thinkingDisclosurePhase(true, '');
    expect(thinkingDisclosureOpen(thinking, null)).toBe(true);
    const manual = { phase: thinking, open: true };
    const answered = thinkingDisclosurePhase(true, '正文');
    expect(thinkingDisclosureOpen(answered, manual)).toBe(false);
    const reopened = { phase: answered, open: true };
    expect(thinkingDisclosureOpen(thinkingDisclosurePhase(true, '正文继续写'), reopened)).toBe(
      true
    );
    expect(thinkingDisclosureOpen(thinkingDisclosurePhase(false, '正文完成'), reopened)).toBe(true);
    expect(thinkingDisclosureOpen(thinkingDisclosurePhase(false, ''), null)).toBe(false);
  });
});

describe('thinking device preference', () => {
  it('defaults on, isolates users and stores only on/off', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(readThinkingPreference('a', storage)).toBe(true);
    writeThinkingPreference('a', false, storage);
    expect(readThinkingPreference('a', storage)).toBe(false);
    expect(readThinkingPreference('b', storage)).toBe(true);
    expect([...values.values()]).toEqual(['off']);
    writeThinkingPreference('a', true, storage);
    expect(readThinkingPreference('a', storage)).toBe(true);
  });

  it('falls back to enabled when storage is unavailable or invalid', () => {
    expect(readThinkingPreference('a', null)).toBe(true);
    const broken = {
      getItem: () => {
        throw Error('blocked');
      },
      setItem: () => {
        throw Error('blocked');
      },
    };
    expect(readThinkingPreference('a', broken)).toBe(true);
    expect(() => writeThinkingPreference('a', false, broken)).not.toThrow();
    expect(readThinkingPreference('a', { ...broken, getItem: () => 'invalid' })).toBe(true);
  });
});
