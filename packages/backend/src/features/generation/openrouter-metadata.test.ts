import { describe, expect, it } from 'vitest';
import { buildGenerationMetadata } from './openrouter-metadata.js';

describe('buildGenerationMetadata', () => {
  it('keeps OpenRouter diagnostics but excludes prompt, reply and credential-shaped fields', () => {
    const metadata = buildGenerationMetadata({
      id: 'gen-1',
      finish_reason: 'stop',
      usage: 0.001,
      prompt: 'private prompt',
      choices: [{ message: { content: 'private reply' } }],
      nested: { input: 'private input', model: 'routed/model' },
      api_key: 'secret',
    });

    expect(metadata.llm_generation_data).toEqual({
      id: 'gen-1',
      finish_reason: 'stop',
      usage: 0.001,
      nested: { model: 'routed/model' },
    });
  });
});
