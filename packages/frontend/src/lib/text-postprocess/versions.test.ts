import { describe, expect, it, vi } from 'vitest';
import { TEXT_POSTPROCESS_SCHEMA_VERSION, TEXT_POSTPROCESS_POLICY_VERSION } from '@miniapp/shared';
import type { ChatMessage, TextPostprocessArtifactSnapshot } from '@miniapp/shared';

import {
  assignVersionBatch,
  chunkVersions,
  collectPostprocessVersions,
  loadVersionSnapshots,
  lookupVersionState,
  verifiedSnapshotArtifact,
  textPostprocessCollectionKey,
  type VersionSnapshotState,
} from './versions';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    session_id: 's1',
    turn_index: 1,
    role: 'assistant',
    revision: 0,
    content: 'hello {{user}}',
    status: 'complete',
    error_code: null,
    finish_reason: 'stop',
    model_id: null,
    created_at: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function snapshot(version: number): TextPostprocessArtifactSnapshot {
  return {
    version,
    published_at: '2026-09-28T00:00:00.000Z',
    artifact: {
      schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
      policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
      rules: [],
    },
  };
}

describe('text postprocess version batches', () => {
  it('collects unique assistant versions and ignores user prompts and nulls', () => {
    expect(
      collectPostprocessVersions([
        message({ id: 'u', role: 'user', postprocess_version: 9 }),
        message({ id: 'a0', postprocess_version: null, turn_index: 0 }),
        message({ id: 'a1', postprocess_version: 3 }),
        message({ id: 'a2', postprocess_version: 3 }),
        message({ id: 'a3', postprocess_version: 1 }),
        message({ id: 'old' }),
      ])
    ).toEqual([1, 3]);
  });

  it('splits a deduped set into batches of 20', () => {
    const versions = Array.from({ length: 21 }, (_, index) => index + 1);
    expect(chunkVersions(versions).map((chunk) => chunk.length)).toEqual([20, 1]);
  });

  it('keeps unavailable versions unavailable instead of borrowing another snapshot', () => {
    const assigned = assignVersionBatch([1, 2, 4], {
      found: [snapshot(2), snapshot(9)],
      unavailable_versions: [1],
    });
    expect(assigned.get(2)).toEqual({ status: 'ready', snapshot: snapshot(2) });
    expect(assigned.get(1)).toEqual({ status: 'unavailable' });
    expect(assigned.get(4)).toEqual({ status: 'unavailable' });
    expect(assigned.has(9)).toBe(false);
    expect(lookupVersionState({ 2: assigned.get(2) as VersionSnapshotState }, 4)).toEqual({
      status: 'loading',
    });
  });

  it('validates once at the cache boundary and freezes the derived snapshot', () => {
    const assigned = assignVersionBatch([2], { found: [snapshot(2)], unavailable_versions: [] });
    const state = assigned.get(2);
    if (state?.status !== 'ready') throw new Error('snapshot rejected');
    expect(Object.isFrozen(state.snapshot)).toBe(true);
    expect(Object.isFrozen(state.snapshot.artifact.rules)).toBe(true);
    const first = verifiedSnapshotArtifact(state.snapshot);
    expect(verifiedSnapshotArtifact(state.snapshot)).toBe(first);
    expect(first).toBe(state.snapshot.artifact);
    expect(
      assignVersionBatch([2], {
        found: [{ ...snapshot(2), artifact: { ...snapshot(2).artifact, rules: [{}] } }] as never,
        unavailable_versions: [],
      }).get(2)
    ).toEqual({ status: 'unavailable' });
  });

  it('puts the API origin and the version set in the query key', () => {
    expect(textPostprocessCollectionKey('https://test.example', [2, 4])).not.toEqual(
      textPostprocessCollectionKey('https://prod.example', [2, 4])
    );
    expect(textPostprocessCollectionKey('https://test.example', [2, 4])).not.toEqual(
      textPostprocessCollectionKey('https://test.example', [4])
    );
  });

  it('fetches only missing versions and does not cache a failed batch as unavailable', async () => {
    const cache = new Map<number, VersionSnapshotState>();
    const postBatch = vi.fn(async (versions: number[]) => {
      if (versions.includes(3)) throw new Error('offline');
      return { found: versions.map((version) => snapshot(version)), unavailable_versions: [] };
    });
    await loadVersionSnapshots({
      versions: [1, 1, 2],
      readCached: (version) => cache.get(version),
      writeCached: (version, state) => {
        cache.set(version, state);
      },
      postBatch,
    });
    expect(postBatch).toHaveBeenCalledTimes(1);
    expect(postBatch).toHaveBeenCalledWith([1, 2]);

    await expect(
      loadVersionSnapshots({
        versions: [1, 3],
        readCached: (version) => cache.get(version),
        writeCached: (version, state) => {
          cache.set(version, state);
        },
        postBatch,
      })
    ).rejects.toThrow('offline');
    expect(cache.get(1)?.status).toBe('ready');
    expect(cache.has(3)).toBe(false);
    expect(postBatch).toHaveBeenLastCalledWith([3]);
  });
});
