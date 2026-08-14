import { describe, expect, it } from 'vitest';

import { resolveSessionTitle, SESSION_TITLE_DISPLAY_LENGTH } from './conversations';

describe('resolveSessionTitle', () => {
  it('uses the stored title when present', () => {
    expect(resolveSessionTitle('周末闲聊', '角色全名')).toBe('周末闲聊');
  });

  it(`truncates every title to ${SESSION_TITLE_DISPLAY_LENGTH} characters`, () => {
    expect(resolveSessionTitle('这是一个很长的会话标题')).toBe('这是一个很长的');
    expect(resolveSessionTitle(null, '这是一个很长的角色名字')).toBe('这是一个很长的');
  });

  it('falls back to the character name, then to 新的对话', () => {
    expect(resolveSessionTitle(null, '凤雪仪')).toBe('凤雪仪');
    expect(resolveSessionTitle('  ', '  ')).toBe('新的对话');
    expect(resolveSessionTitle(null)).toBe('新的对话');
  });

  it('counts unicode code points rather than UTF-16 code units', () => {
    expect(resolveSessionTitle('😀一二三四五六七')).toBe('😀一二三四五六');
  });
});
