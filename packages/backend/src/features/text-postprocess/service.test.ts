import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishRequestDigest, rollbackRequestDigest, textPostprocessDigest } from './digest.js';
import { TextPostprocessRequestError } from './errors.js';
import type { TextPostprocessRepository } from './repository.js';

const validate = vi.hoisted(() => vi.fn());

vi.mock('./validate-pool.js', () => ({
  validateTextPostprocessSource: validate,
}));

import {
  publishTextPostprocess,
  readTextPostprocessVersions,
  rollbackTextPostprocess,
  saveTextPostprocessDraft,
  setTextPostprocessRepositoryForTests,
} from './service.js';

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const REQUEST = '00000000-0000-4000-8000-000000000101';
const UPDATED = '2026-09-28T00:00:00.000Z';
const DRAFT_ID = '00000000-0000-4000-8000-0000000000d1';
const SOURCE = {
  schema_version: 1 as const,
  policy_version: 1 as const,
  rules: [
    {
      id: 'dialogue',
      name: '对白',
      description: '',
      enabled: true,
      pattern: 'hello',
      flags: 'g',
      replacement: '<p>SECRET_TEMPLATE</p>',
      css: '',
      notes: '',
    },
  ],
};

const DIGEST = textPostprocessDigest(SOURCE);

const ARTIFACT = {
  schema_version: 1 as const,
  policy_version: 1 as const,
  rules: [
    {
      id: 'dialogue',
      enabled: true,
      pattern: 'hello',
      flags: 'g',
      groups: { count: 0, names: [], name_by_index: [] },
      placement: 'block' as const,
      tree: [
        {
          type: 'element' as const,
          tag: 'p' as const,
          attributes: [],
          action: null,
          children: [{ type: 'text' as const, text: 'SECRET_TEMPLATE' }],
        },
      ],
      css: [],
    },
  ],
};

function repo() {
  return {
    readSnapshots: vi.fn(),
    readAdminState: vi.fn(),
    readDraft: vi.fn(),
    readSnapshotSource: vi.fn(),
    saveDraft: vi.fn(),
    publish: vi.fn(),
    rollback: vi.fn(),
    discardDraft: vi.fn(),
    getRequest: vi.fn(),
  };
}

function use(fake: ReturnType<typeof repo>) {
  setTextPostprocessRepositoryForTests(fake as unknown as TextPostprocessRepository);
  return fake;
}

describe('text postprocess mutations', () => {
  beforeEach(() => {
    validate.mockReset();
    validate.mockResolvedValue({
      ok: true,
      artifact: ARTIFACT,
    });
    setTextPostprocessRepositoryForTests(null);
  });

  it('reads a version batch through one repository call', async () => {
    const fake = use(repo());
    fake.readSnapshots.mockResolvedValue({ found: [], unavailable_versions: [2, 9] });
    await expect(readTextPostprocessVersions([2, 9])).resolves.toEqual({
      found: [],
      unavailable_versions: [2, 9],
    });
    expect(fake.readSnapshots).toHaveBeenCalledTimes(1);
    expect(fake.readSnapshots).toHaveBeenCalledWith([2, 9]);
  });

  it('saves a draft without compiling it and maps a CAS conflict without retrying', async () => {
    const fake = use(repo());
    fake.saveDraft.mockResolvedValue({
      kind: 'database',
      error: { code: '40001', message: 'cas_conflict: draft changed' },
    });
    await expect(
      saveTextPostprocessDraft(ACTOR, {
        request_id: REQUEST,
        expected_runtime_version: null,
        expected_draft_updated_at: null,
        expected_draft_digest: null,
        source: SOURCE,
      })
    ).rejects.toMatchObject({ code: 'cas_conflict' });
    expect(validate).not.toHaveBeenCalled();
    expect(fake.saveDraft).toHaveBeenCalledTimes(1);
    expect(fake.getRequest).not.toHaveBeenCalled();
    const args = fake.saveDraft.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.p_content_digest).toBe(textPostprocessDigest(SOURCE));
    expect(args.p_expected_runtime_version).toBeNull();
  });

  it('does not publish when compilation or the validation worker fails', async () => {
    const fake = use(repo());
    fake.getRequest.mockResolvedValue({ kind: 'ok', value: null });
    fake.readDraft.mockResolvedValue({
      draftRevision: DRAFT_ID,
      updatedAt: UPDATED,
      contentDigest: DIGEST,
      baseVersion: 1,
      source: SOURCE,
    });
    validate.mockResolvedValueOnce({
      ok: false,
      reason: 'rejected',
      diagnostics: [
        {
          code: 'INVALID_PATTERN',
          rule_id: 'dialogue',
          field: 'pattern',
          message: 'Pattern is not a supported regular expression.',
          location: null,
        },
      ],
    });
    const request = {
      request_id: REQUEST,
      expected_runtime_version: 1,
      expected_draft_updated_at: UPDATED,
      expected_draft_digest: DIGEST,
      draft_revision: DRAFT_ID,
    };
    await expect(publishTextPostprocess(ACTOR, request)).rejects.toMatchObject({
      code: 'compile_rejected',
    });
    validate.mockResolvedValueOnce({ ok: false, reason: 'queue_full' });
    await expect(publishTextPostprocess(ACTOR, request)).rejects.toMatchObject({
      code: 'VALIDATION_UNAVAILABLE',
      statusCode: 503,
    });
    expect(fake.publish).not.toHaveBeenCalled();
  });

  it('rejects publish when the saved draft changed before compilation', async () => {
    const fake = use(repo());
    fake.getRequest.mockResolvedValue({ kind: 'ok', value: null });
    fake.readDraft.mockResolvedValue({
      draftRevision: DRAFT_ID,
      updatedAt: UPDATED,
      contentDigest: 'cd'.repeat(32),
      baseVersion: 1,
      source: SOURCE,
    });
    await expect(
      publishTextPostprocess(ACTOR, {
        request_id: REQUEST,
        expected_runtime_version: 1,
        expected_draft_updated_at: UPDATED,
        expected_draft_digest: DIGEST,
        draft_revision: DRAFT_ID,
      })
    ).rejects.toMatchObject({ code: 'cas_conflict' });
    expect(validate).not.toHaveBeenCalled();
    expect(fake.publish).not.toHaveBeenCalled();
  });

  it('publishes only after compilation and returns the RPC conflict if the draft moves', async () => {
    const fake = use(repo());
    fake.getRequest.mockResolvedValue({ kind: 'ok', value: null });
    fake.readDraft.mockResolvedValue({
      draftRevision: DRAFT_ID,
      updatedAt: UPDATED,
      contentDigest: DIGEST,
      baseVersion: 1,
      source: SOURCE,
    });
    fake.publish.mockResolvedValue({
      kind: 'database',
      error: { code: '40001', message: 'cas_conflict: draft changed' },
    });
    await expect(
      publishTextPostprocess(ACTOR, {
        request_id: REQUEST,
        expected_runtime_version: 1,
        expected_draft_updated_at: UPDATED,
        expected_draft_digest: DIGEST,
        draft_revision: DRAFT_ID,
      })
    ).rejects.toMatchObject({ code: 'cas_conflict' });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(fake.publish).toHaveBeenCalledTimes(1);
    expect(fake.publish.mock.calls[0]?.[0]).toMatchObject({
      p_source: SOURCE,
      p_artifact: ARTIFACT,
    });
  });

  it('replays the same request and conflicts when the digest differs', async () => {
    const fake = use(repo());
    fake.getRequest.mockResolvedValue({
      kind: 'ok',
      value: { action: 'publish', replayed: false, version: 2 },
    });
    fake.readSnapshotSource.mockResolvedValue({
      version: 2,
      source: SOURCE,
      artifact: ARTIFACT,
      schema_version: 1,
      policy_version: 1,
    });
    fake.publish.mockResolvedValueOnce({
      kind: 'ok',
      value: { action: 'publish', replayed: true, version: 2 },
    });
    await expect(
      publishTextPostprocess(ACTOR, {
        request_id: REQUEST,
        expected_runtime_version: 1,
        expected_draft_updated_at: UPDATED,
        expected_draft_digest: DIGEST,
        draft_revision: DRAFT_ID,
      })
    ).resolves.toMatchObject({ replayed: true, version: 2 });
    expect(validate).not.toHaveBeenCalled();

    fake.publish.mockResolvedValueOnce({
      kind: 'database',
      error: { code: 'P0001', message: 'request_id_conflict: request_id was already used' },
    });
    await expect(
      publishTextPostprocess(ACTOR, {
        request_id: REQUEST,
        expected_runtime_version: 1,
        expected_draft_updated_at: UPDATED,
        expected_draft_digest: DIGEST,
        draft_revision: DRAFT_ID,
      })
    ).rejects.toMatchObject({ code: 'request_id_conflict' });
    expect(fake.publish).toHaveBeenCalledTimes(2);
  });

  it('looks up an unknown commit once and does not write again', async () => {
    const fake = use(repo());
    fake.getRequest.mockResolvedValueOnce({ kind: 'ok', value: null }).mockResolvedValueOnce({
      kind: 'ok',
      value: { action: 'publish', replayed: false, version: 5 },
    });
    fake.readDraft.mockResolvedValue({
      draftRevision: DRAFT_ID,
      updatedAt: UPDATED,
      contentDigest: DIGEST,
      baseVersion: 4,
      source: SOURCE,
    });
    fake.publish.mockResolvedValue({ kind: 'transport' });
    await expect(
      publishTextPostprocess(ACTOR, {
        request_id: REQUEST,
        expected_runtime_version: 4,
        expected_draft_updated_at: UPDATED,
        expected_draft_digest: DIGEST,
        draft_revision: DRAFT_ID,
      })
    ).resolves.toMatchObject({ version: 5 });
    expect(fake.publish).toHaveBeenCalledTimes(1);

    fake.getRequest.mockResolvedValue({ kind: 'ok', value: null });
    await expect(
      publishTextPostprocess(ACTOR, {
        request_id: REQUEST,
        expected_runtime_version: 4,
        expected_draft_updated_at: UPDATED,
        expected_draft_digest: DIGEST,
        draft_revision: DRAFT_ID,
      })
    ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN', statusCode: 503 });
    expect(fake.publish).toHaveBeenCalledTimes(2);
  });

  it('hides unknown SQL text and creates rollback as a new version', async () => {
    const fake = use(repo());
    fake.saveDraft.mockResolvedValue({
      kind: 'database',
      error: {
        code: '55000',
        message: 'text postprocess version invariant broken: SECRET_TEMPLATE',
      },
    });
    await expect(
      saveTextPostprocessDraft(ACTOR, {
        request_id: REQUEST,
        expected_runtime_version: null,
        expected_draft_updated_at: null,
        expected_draft_digest: null,
        source: SOURCE,
      })
    ).rejects.toMatchObject({
      code: 'TEXT_POSTPROCESS_FAILED',
      message: 'Text postprocess request failed.',
    });

    fake.getRequest.mockResolvedValue({ kind: 'ok', value: null });
    fake.readSnapshotSource.mockResolvedValue({
      version: 2,
      source: SOURCE,
      schema_version: 1,
      policy_version: 1,
    });
    fake.rollback.mockResolvedValue({
      kind: 'ok',
      value: { action: 'rollback', replayed: false, version: 6, target_version: 2 },
    });
    const rolled = await rollbackTextPostprocess(ACTOR, {
      request_id: REQUEST,
      expected_runtime_version: 5,
      target_version: 2,
    });
    expect(rolled.version).toBe(6);
    expect(rolled.version).not.toBe(2);
    expect(fake.rollback).toHaveBeenCalledTimes(1);
    expect(fake.rollback.mock.calls[0]?.[0]).toMatchObject({
      p_source: SOURCE,
      p_artifact: ARTIFACT,
    });
    expect(
      String((fake.rollback.mock.calls[0]?.[0] as { p_target_version: number }).p_target_version)
    ).toBe('2');
  });

  it('binds request digests to source and artifact and rejects missing worker artifact', async () => {
    const input = {
      request_id: REQUEST,
      expected_runtime_version: 1,
      expected_draft_updated_at: UPDATED,
      expected_draft_digest: DIGEST,
      draft_revision: DRAFT_ID,
    };
    const payload = { source: SOURCE, artifact: ARTIFACT };
    expect(publishRequestDigest(input, payload)).not.toBe(
      publishRequestDigest(input, { ...payload, artifact: {} })
    );
    const rollback = { request_id: REQUEST, expected_runtime_version: 1, target_version: 2 };
    expect(rollbackRequestDigest(rollback, payload)).not.toBe(
      rollbackRequestDigest(rollback, { ...payload, artifact: {} })
    );
    const fake = use(repo());
    fake.getRequest.mockResolvedValue({ kind: 'ok', value: null });
    fake.readDraft.mockResolvedValue({
      draftRevision: DRAFT_ID,
      updatedAt: UPDATED,
      contentDigest: DIGEST,
      baseVersion: 1,
      source: SOURCE,
    });
    validate.mockResolvedValue({ ok: true });
    await expect(publishTextPostprocess(ACTOR, input)).rejects.toMatchObject({
      code: 'compile_rejected',
    });
    expect(fake.publish).not.toHaveBeenCalled();
  });

  it('does not compile or roll back an unsupported policy', async () => {
    const fake = use(repo());
    fake.getRequest.mockResolvedValue({ kind: 'ok', value: null });
    fake.readSnapshotSource.mockResolvedValue({
      version: 2,
      source: SOURCE,
      schema_version: 1,
      policy_version: 2,
    });
    await expect(
      rollbackTextPostprocess(ACTOR, {
        request_id: REQUEST,
        expected_runtime_version: 5,
        target_version: 2,
      })
    ).rejects.toBeInstanceOf(TextPostprocessRequestError);
    await expect(
      rollbackTextPostprocess(ACTOR, {
        request_id: REQUEST,
        expected_runtime_version: 5,
        target_version: 2,
      })
    ).rejects.toMatchObject({ code: 'policy_unsupported' });
    expect(validate).not.toHaveBeenCalled();
    expect(fake.rollback).not.toHaveBeenCalled();
  });
});
