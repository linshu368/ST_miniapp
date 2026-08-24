import { describe, expect, it } from 'vitest';
import { formatFreeQuotaExhaustedDialog, truncateCharacterName } from './free-quota-dialog';

describe('free quota exhausted dialog copy', () => {
  it('keeps character names up to seven characters', () => {
    expect(truncateCharacterName('七个字的角色名')).toBe('七个字的角色名');
  });

  it('limits long character names to seven displayed characters', () => {
    expect(truncateCharacterName('这是一个很长的角色名字')).toBe('这是一个很长…');
  });

  it('uses a safe fallback for missing character names', () => {
    expect(truncateCharacterName('  ')).toBe('当前角色');
  });

  it('replaces the character placeholder in runtime copy', () => {
    expect(
      formatFreeQuotaExhaustedDialog(
        {
          title: '和「{characterName}」的免费时光结束了',
          description: '{characterName} 的后续对话将消耗星尘。',
        },
        '非常非常长的角色名字'
      )
    ).toEqual({
      title: '和「非常非常长的…」的免费时光结束了',
      description: '非常非常长的… 的后续对话将消耗星尘。',
    });
  });
});
