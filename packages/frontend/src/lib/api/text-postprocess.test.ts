import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiClient = vi.fn();

vi.mock('./client', () => ({
  API_URL: 'https://example.test',
  apiClient: (...args: unknown[]) => apiClient(...args),
}));

import { postTextPostprocessVersions } from './text-postprocess';

const SNAPSHOT = {
  version: 2,
  published_at: '2026-09-28T00:00:00.000Z',
  artifact: { schema_version: 1, policy_version: 1, rules: [] },
};

describe('postTextPostprocessVersions', () => {
  beforeEach(() => {
    apiClient.mockReset();
  });

  it('posts one deduped batch and keeps found separate from unavailable', async () => {
    apiClient.mockResolvedValue({
      found: [SNAPSHOT],
      unavailable_versions: [4],
    });
    await expect(postTextPostprocessVersions([2, 4])).resolves.toEqual({
      found: [SNAPSHOT],
      unavailable_versions: [4],
    });
    expect(apiClient).toHaveBeenCalledWith(
      '/api/v1/text-postprocess/versions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ versions: [2, 4] }),
      })
    );
  });

  it('rejects a batch that is not the shared snapshot shape', async () => {
    apiClient.mockResolvedValue({ found: [{ version: 1 }], unavailable_versions: [] });
    await expect(postTextPostprocessVersions([1])).rejects.toThrow(
      'text postprocess version batch was rejected'
    );
  });
});
