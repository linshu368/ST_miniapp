import { describe, expect, it } from 'vitest';
import { extractMarkedUserInput } from './llm-user-input.js';

describe('extractMarkedUserInput', () => {
  it.each(['normal', 'regenerate', 'swipe'])(
    'extracts the marked user message for %s requests regardless of later injections',
    () => {
      const result = extractMarkedUserInput([
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '真实输入', st_user_input: true },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'depth injection' },
      ]);

      expect(result.userInput).toBe('真实输入');
      expect(result.issue).toBeNull();
      expect(result.messages).toEqual([
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '真实输入' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'depth injection' },
      ]);
    }
  );

  it('extracts text from a marked multimodal message', () => {
    const result = extractMarkedUserInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: '带图片的输入' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
        st_user_input: true,
      },
    ]);

    expect(result.userInput).toBe('带图片的输入');
    expect(result.issue).toBeNull();
  });

  it('does not infer input from jailbreak or depth messages when the marker is missing', () => {
    const result = extractMarkedUserInput([
      { role: 'user', content: '##系统指令...##用户指令:' },
      { role: 'user', content: '---\n变量输出格式' },
    ]);

    expect(result.userInput).toBe('');
    expect(result.issue).toBe('marker_missing');
  });

  it('rejects duplicated markers instead of relying on message order', () => {
    const result = extractMarkedUserInput([
      { role: 'user', content: 'first', st_user_input: true },
      { role: 'user', content: 'second', st_user_input: true },
    ]);

    expect(result.userInput).toBe('');
    expect(result.issue).toBe('marker_duplicated');
    expect(result.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('rejects a marker attached to an invalid message', () => {
    const result = extractMarkedUserInput([
      { role: 'assistant', content: 'not user input', st_user_input: true },
    ]);

    expect(result.userInput).toBe('');
    expect(result.issue).toBe('marked_message_invalid');
  });
});
