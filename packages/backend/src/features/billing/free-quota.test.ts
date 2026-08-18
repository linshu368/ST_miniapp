import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT,
  parseCharacterFreeChatQuotaLimit,
} from '@miniapp/shared';
import {
  CHARACTER_FREE_CHAT_QUOTA_LIMIT,
  isQuotaTrackableCharacterId,
  parseFreeQuotaExhaustedDialogConfig,
} from './free-quota.js';

describe('character free chat quota pricing', () => {
  it('defaults to a 40-round limit when runtime_config is missing', () => {
    expect(CHARACTER_FREE_CHAT_QUOTA_LIMIT).toBe(40);
    expect(DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT).toBe(40);
    expect(parseCharacterFreeChatQuotaLimit(null)).toBe(40);
    expect(parseCharacterFreeChatQuotaLimit(40)).toBe(40);
    expect(parseCharacterFreeChatQuotaLimit(25)).toBe(25);
    expect(parseCharacterFreeChatQuotaLimit(0)).toBe(40);
    expect(parseCharacterFreeChatQuotaLimit(-1)).toBe(40);
    expect(parseCharacterFreeChatQuotaLimit(3.5)).toBe(40);
  });
});

describe('isQuotaTrackableCharacterId', () => {
  it('accepts a platform character uuid regardless of case', () => {
    expect(isQuotaTrackableCharacterId('3f1b9c2e-4d5a-6b7c-8d9e-0f1a2b3c4d5e')).toBe(true);
    expect(isQuotaTrackableCharacterId('3F1B9C2E-4D5A-6B7C-8D9E-0F1A2B3C4D5E')).toBe(true);
  });

  it('rejects a missing or malformed character id', () => {
    expect(isQuotaTrackableCharacterId(null)).toBe(false);
    expect(isQuotaTrackableCharacterId(undefined)).toBe(false);
    expect(isQuotaTrackableCharacterId('')).toBe(false);
    expect(isQuotaTrackableCharacterId('42')).toBe(false);
    expect(isQuotaTrackableCharacterId('platform_3f1b9c2e-4d5a-6b7c-8d9e-0f1a2b3c4d5e.png')).toBe(
      false
    );
    expect(isQuotaTrackableCharacterId('3f1b9c2e4d5a6b7c8d9e0f1a2b3c4d5e')).toBe(false);
  });
});

describe('free quota exhausted dialog config', () => {
  it('accepts valid runtime copy', () => {
    expect(
      parseFreeQuotaExhaustedDialogConfig({
        title: '额度已用完',
        description: '后续聊天将消耗星尘。',
      })
    ).toEqual({
      title: '额度已用完',
      description: '后续聊天将消耗星尘。',
    });
  });

  it('falls back to safe defaults for missing or invalid config', () => {
    expect(parseFreeQuotaExhaustedDialogConfig(null)).toMatchObject({
      title: '▎ 和「{characterName}」的 40 轮免费时光结束了',
    });
    expect(
      parseFreeQuotaExhaustedDialogConfig({
        title: '',
        description: '后续聊天将消耗星尘。',
      })
    ).toMatchObject({ title: '▎ 和「{characterName}」的 40 轮免费时光结束了' });
  });
});
