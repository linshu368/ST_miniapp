import { describe, expect, it } from 'vitest';

import { parseChatEngineMode } from './chat-engine.js';

describe('parseChatEngineMode', () => {
  it('读取 runtime_config 的对象写法', () => {
    expect(parseChatEngineMode({ mode: 'self_hosted' })).toEqual({
      mode: 'self_hosted',
      degraded: false,
    });
  });

  it('兼容裸字符串写法', () => {
    expect(parseChatEngineMode('sillytavern')).toEqual({
      mode: 'sillytavern',
      degraded: false,
    });
  });

  // 值写坏时必须留在 ST：默认值一旦反过来，一次手滑就会把所有用户推到新链路。
  it.each([null, undefined, {}, { mode: 'selfhosted' }, 42, ['self_hosted']])(
    '无法识别的值 %j 回落到 sillytavern 并标记 degraded',
    (value) => {
      expect(parseChatEngineMode(value)).toEqual({ mode: 'sillytavern', degraded: true });
    }
  );
});
