import { describe, expect, it } from 'vitest';

import { DEFAULT_USER_DISPLAY_NAME, replaceUserPlaceholder } from '../user-placeholder.js';

describe('replaceUserPlaceholder', () => {
  it('replaces every {{user}} with the display name', () => {
    expect(replaceUserPlaceholder('你好，{{user}}。{{user}} 来了。', '路人甲')).toBe(
      '你好，路人甲。路人甲 来了。'
    );
  });

  it('falls back to the default name when display name is empty', () => {
    expect(replaceUserPlaceholder('嗨 {{user}}', null)).toBe(`嗨 ${DEFAULT_USER_DISPLAY_NAME}`);
    expect(replaceUserPlaceholder('嗨 {{user}}', '   ')).toBe(`嗨 ${DEFAULT_USER_DISPLAY_NAME}`);
  });

  it('does not interpret $ sequences in the display name', () => {
    expect(replaceUserPlaceholder('{{user}} 到了', 'A$&B$1')).toBe('A$&B$1 到了');
  });

  it('leaves text without the placeholder unchanged', () => {
    expect(replaceUserPlaceholder('你好', '路人甲')).toBe('你好');
  });
});
