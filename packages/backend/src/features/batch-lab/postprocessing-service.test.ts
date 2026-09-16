import { describe, expect, it } from 'vitest';
import type { BatchLabProcessorVersion } from '@miniapp/shared';
import {
  computeProcessorDigest,
  renderSafeHtml,
  runPostprocessor,
} from './postprocessing-service.js';

const baseVersion = {
  id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
  name: 'processor',
  protocol: 'regex_json_v1',
  digest: `sha256:${'a'.repeat(64)}`,
  created_at: '2026-09-11T06:00:00.000Z',
} satisfies Omit<BatchLabProcessorVersion, 'config'>;

describe('Batch Lab postprocessing service', () => {
  it('keeps zero-match processing successful with the original text', async () => {
    const result = await runPostprocessor(
      {
        ...baseVersion,
        config: {
          protocol: 'regex_json_v1',
          rules: [{ pattern: 'missing', flags: 'g', replacement: 'hit' }],
          timeout_ms: 250,
        },
      },
      'hello'
    );

    expect(result.status).toBe('success');
    expect(result.match_count).toBe(0);
    expect(result.output_text).toBe('hello');
    expect(result.error_code).toBeNull();
  });

  it('applies ordered regex rules and counts matches before each replacement', async () => {
    const result = await runPostprocessor(
      {
        ...baseVersion,
        config: {
          protocol: 'regex_json_v1',
          rules: [
            { pattern: 'cat', flags: 'g', replacement: 'dog' },
            { pattern: 'dog', flags: 'g', replacement: 'fox' },
          ],
          timeout_ms: 250,
        },
      },
      'cat cat'
    );

    expect(result.status).toBe('success');
    expect(result.match_count).toBe(4);
    expect(result.output_text).toBe('fox fox');
  });

  it('returns the original text on invalid regex config', async () => {
    const result = await runPostprocessor(
      {
        ...baseVersion,
        config: {
          protocol: 'regex_json_v1',
          rules: [{ pattern: '(', flags: 'g', replacement: 'x' }],
          timeout_ms: 50,
        },
      },
      'hello'
    );

    expect(result.status).toBe('validation_error');
    expect(result.output_text).toBe('hello');
    expect(result.sanitized_html).toBe('hello');
    expect(result.error_code).toBe('BATCH_LAB_PROCESSOR_VALIDATION_ERROR');
  });

  it('escapes generated HTML so dangerous tags and URLs render as text', () => {
    expect(renderSafeHtml('<script>alert(1)</script>\n<a href="javascript:alert(1)">x</a>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;<br>&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;'
    );
  });

  it('terminates catastrophic regex processing without blanking the output', async () => {
    const input = `${'a'.repeat(30_000)}!`;
    const started = Date.now();
    const result = await runPostprocessor(
      {
        ...baseVersion,
        config: {
          protocol: 'regex_json_v1',
          rules: [{ pattern: '(a+)+$', flags: 'g', replacement: 'x' }],
          timeout_ms: 20,
        },
      },
      input
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).toBe('timeout');
    expect(result.output_text).toBe(input);
    expect(result.error_code).toBe('BATCH_LAB_PROCESSOR_TIMEOUT');
  });

  it('uses canonical config JSON for stable processor digests', () => {
    expect(computeProcessorDigest({ protocol: 'none_v1' })).toBe(
      'sha256:8cdd3d1a3c9c48ddd94f48fcd60b303f9f3e295d6c3c15d436bb475459b33345'
    );
  });
});
