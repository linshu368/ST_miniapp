import { describe, expect, it } from 'vitest';
import { toSafePresetPayload } from '../platform-presets.js';

describe('toSafePresetPayload', () => {
  it('keeps preset-owned fields and removes connection fields', () => {
    expect(
      toSafePresetPayload({
        temperature: 0.8,
        prompts: [{ identifier: 'main' }],
        custom_url: 'https://untrusted.example',
        custom_model: 'untrusted/model',
        reverse_proxy: 'https://untrusted.example',
        proxy_password: 'secret',
      })
    ).toEqual({
      temperature: 0.8,
      prompts: [{ identifier: 'main' }],
    });
  });
});
