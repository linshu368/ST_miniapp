import { describe, expect, it } from 'vitest';
import { analyzePresetPayload, parsePresetJson } from './presetValidation';

describe('platform preset validation', () => {
  it('summarizes a valid SillyTavern preset', () => {
    const result = analyzePresetPayload({
      temperature: 0.8,
      prompts: [{ identifier: 'main', name: 'Main', content: 'Hello' }],
      prompt_order: [
        {
          character_id: 100001,
          order: [{ identifier: 'main', enabled: true }],
        },
      ],
      extensions: { regex: [] },
    });

    expect(result.valid).toBe(true);
    expect(result.summary.promptCount).toBe(1);
    expect(result.summary.orderedPromptCount).toBe(1);
    expect(result.summary.extensionCount).toBe(1);
    expect(result.summary.effectiveKeys).toContain('temperature');
  });

  it('rejects invalid prompt structures', () => {
    const result = analyzePresetPayload({
      prompts: [{ name: 'missing identifier' }],
      prompt_order: 'invalid',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('identifier'),
        expect.stringContaining('prompt_order'),
      ])
    );
  });

  it('rejects a preset with no runtime-effective fields', () => {
    const result = analyzePresetPayload({ custom_model: 'provider/model' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('不能发布');
  });

  it('warns about ignored connection and overridden fields', () => {
    const result = analyzePresetPayload({
      temperature: 1,
      custom_model: 'provider/model',
      custom_url: 'https://example.invalid',
      openai_max_context: 4096,
    });

    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toContain('custom_model');
    expect(result.warnings.join(' ')).toContain('custom_url');
    expect(result.warnings.join(' ')).toContain('openai_max_context');
  });

  it('returns a readable error for malformed JSON', () => {
    const result = parsePresetJson('{"temperature":');
    expect(result.value).toBeNull();
    expect(result.analysis.valid).toBe(false);
    expect(result.analysis.errors[0]).toContain('JSON 格式错误');
  });
});
