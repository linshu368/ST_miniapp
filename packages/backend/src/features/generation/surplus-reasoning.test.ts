import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSurplusReasoningParameters } from './surplus-reasoning.js';
import {
  getProviderModelDirectory,
  getCachedSurplusModelDirectory,
} from '../../platform/model-provider-directory.js';

vi.mock('../../platform/model-provider-directory.js', () => ({
  getProviderModelDirectory: vi.fn(),
  getCachedSurplusModelDirectory: vi.fn(),
}));
const model = {
  provider: 'surplus' as const,
  id: 'vendor/model',
  name: 'Model',
  description: null,
  context_length: null,
  prompt_usd_per_token: 0,
  completion_usd_per_token: 0,
  status: 'available' as const,
  raw_status_label: null,
};
const directory = {
  provider: 'surplus' as const,
  fetched_at: '2026-11-10T00:00:00.000Z',
  stale: false,
};

describe('getSurplusReasoningParameters', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([true, false])(
    'does not invent universally accepted effort values for enabled=%s',
    async (enabled) => {
      vi.mocked(getProviderModelDirectory).mockResolvedValue({
        ...directory,
        models: [{ ...model, supported_parameters: ['reasoning_effort', 'include_reasoning'] }],
      });
      await expect(getSurplusReasoningParameters('vendor/model', enabled)).resolves.toEqual({
        parameters: {},
        supportedParameters: ['reasoning_effort', 'include_reasoning'],
        requestedEnabled: enabled,
        control: 'provider_default',
        reason: 'effort_values_unspecified',
      });
    }
  );

  it('marks unsupported or unknown models without synthesizing a reasoning object', async () => {
    vi.mocked(getProviderModelDirectory).mockResolvedValue({ ...directory, models: [model] });
    await expect(getSurplusReasoningParameters('unknown', true)).resolves.toMatchObject({
      parameters: {},
      control: 'unavailable',
      reason: 'unsupported',
    });
  });

  it('degrades directory failure without failing generation', async () => {
    vi.mocked(getProviderModelDirectory).mockRejectedValue(new Error('directory unavailable'));
    await expect(getSurplusReasoningParameters('vendor/model', false)).resolves.toMatchObject({
      parameters: {},
      requestedEnabled: false,
      control: 'unavailable',
      reason: 'directory_unavailable',
    });
  });

  it('does not fetch on cached-only diagnosis, whether the existing cache is cold or warm', async () => {
    vi.mocked(getCachedSurplusModelDirectory).mockReturnValue(null);
    await expect(
      getSurplusReasoningParameters('vendor/model', true, { cachedOnly: true })
    ).resolves.toMatchObject({
      reason: 'directory_unavailable',
    });
    vi.mocked(getCachedSurplusModelDirectory).mockReturnValue({
      ...directory,
      models: [{ ...model, supported_parameters: ['reasoning'] }],
    });
    await expect(
      getSurplusReasoningParameters('vendor/model', false, { cachedOnly: true })
    ).resolves.toMatchObject({
      supportedParameters: ['reasoning'],
      control: 'provider_default',
    });
    expect(getProviderModelDirectory).not.toHaveBeenCalled();
  });
});
