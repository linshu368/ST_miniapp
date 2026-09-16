import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toDisplayResult, toProcessorVersion } from './BatchLabProcessorRepository.js';

const MIGRATION_PATH = new URL(
  '../../../../shared/migrations/20260916_batch_lab_postprocessing.sql',
  import.meta.url
);

describe('BatchLabProcessorRepository mappers', () => {
  it('maps processor versions through the shared contract', () => {
    expect(
      toProcessorVersion({
        id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        name: 'No postprocessing',
        protocol: 'none_v1',
        config: { protocol: 'none_v1' },
        digest: `sha256:${'a'.repeat(64)}`,
        created_at: '2026-09-11T06:00:00.000Z',
      })
    ).toMatchObject({
      protocol: 'none_v1',
      config: { protocol: 'none_v1' },
    });
  });

  it('maps display results without exposing storage-only fields', () => {
    expect(
      toDisplayResult({
        id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        processor_version_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
        processor_digest: `sha256:${'a'.repeat(64)}`,
        status: 'success',
        error_code: null,
        match_count: 0,
        input_text: '<script>x</script>',
        output_text: '<script>x</script>',
        sanitized_html: '&lt;script&gt;x&lt;/script&gt;',
        renderer_protocol: 'batch_lab_html_v1',
        renderer_version: 1,
        created_at: '2026-09-11T06:00:00.000Z',
      })
    ).toMatchObject({
      renderer: { protocol: 'batch_lab_html_v1', version: 1 },
      sanitized_html: '&lt;script&gt;x&lt;/script&gt;',
    });
  });
});

describe('postprocessing migration invariants', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  it('makes processor versions and display results immutable', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON batch_lab.processor_versions');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON batch_lab.display_results');
    expect(sql).toContain('BATCH_LAB_PROCESSOR_VERSION_IMMUTABLE');
    expect(sql).toContain('BATCH_LAB_DISPLAY_RESULT_IMMUTABLE');
  });

  it('keeps postprocessing storage service-role only with RLS enabled', () => {
    expect(sql).toContain('ALTER TABLE batch_lab.processor_versions ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE batch_lab.display_results ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'REVOKE ALL ON TABLE batch_lab.processor_versions FROM PUBLIC, anon, authenticated'
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE batch_lab.display_results FROM PUBLIC, anon, authenticated'
    );
  });

  it('marks display results as display-only rather than generation context', () => {
    expect(sql).toContain('display-only and never generation context');
    expect(sql).toContain("renderer_protocol     TEXT NOT NULL DEFAULT 'batch_lab_html_v1'");
  });
});
