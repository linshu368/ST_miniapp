import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSurplusReasoningRejections,
  getSurplusReasoningParameters,
  isSurplusReasoningRejection,
  learnSurplusReasoningRejection,
  noteSurplusReasoningRejected,
  surplusReasoningAccepted,
  surplusReasoningBody,
} from './surplus-reasoning.js';
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

  it.each([
    [true, 'medium'],
    [false, 'none'],
  ] as const)(
    'maps the thinking switch (%s) to effort %s in the declared spelling',
    async (enabled, effort) => {
      vi.mocked(getProviderModelDirectory).mockResolvedValue({
        ...directory,
        models: [{ ...model, supported_parameters: ['reasoning_effort', 'include_reasoning'] }],
      });
      await expect(getSurplusReasoningParameters('vendor/model', enabled)).resolves.toEqual({
        parameters: { reasoning_effort: effort },
        supportedParameters: ['reasoning_effort', 'include_reasoning'],
        requestedEnabled: enabled,
        control: 'effort',
        reason: 'effort_mapped',
      });
    }
  );

  it('prefers the reasoning object when the model declares it', async () => {
    vi.mocked(getProviderModelDirectory).mockResolvedValue({
      ...directory,
      models: [{ ...model, supported_parameters: ['reasoning', 'reasoning_effort'] }],
    });
    await expect(getSurplusReasoningParameters('vendor/model', false)).resolves.toMatchObject({
      parameters: { reasoning: { effort: 'none' } },
      control: 'effort',
    });
  });

  it('sends nothing for models that declare no reasoning control', async () => {
    vi.mocked(getProviderModelDirectory).mockResolvedValue({ ...directory, models: [model] });
    await expect(getSurplusReasoningParameters('unknown', true)).resolves.toMatchObject({
      parameters: {},
      control: 'unavailable',
      reason: 'unsupported',
    });
  });

  it('still sends the object form when the directory is unavailable; Surplus drops it if unsupported', async () => {
    vi.mocked(getProviderModelDirectory).mockRejectedValue(new Error('directory unavailable'));
    await expect(getSurplusReasoningParameters('vendor/model', false)).resolves.toMatchObject({
      parameters: { reasoning: { effort: 'none' } },
      requestedEnabled: false,
      control: 'effort',
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
      control: 'effort',
    });
    expect(getProviderModelDirectory).not.toHaveBeenCalled();
  });
});

describe('surplusReasoningBody', () => {
  const base = {
    parameters: {},
    requestedEnabled: true,
    control: 'effort' as const,
    reason: 'effort_mapped' as const,
  };

  it('follows the switch of the current turn, not the prepared default', () => {
    const resolution = { ...base, supportedParameters: ['reasoning'] };
    expect(surplusReasoningBody(resolution, true)).toEqual({ reasoning: { effort: 'medium' } });
    expect(surplusReasoningBody(resolution, false)).toEqual({ reasoning: { effort: 'none' } });
  });

  it('adds nothing when there is no resolution or no control', () => {
    expect(surplusReasoningBody(undefined, false)).toEqual({});
    expect(
      surplusReasoningBody({ ...base, control: 'unavailable', supportedParameters: [] }, false)
    ).toEqual({});
  });
});

describe('strict upstream providers', () => {
  const resolution = {
    parameters: {},
    supportedParameters: ['reasoning'],
    requestedEnabled: true,
    control: 'effort' as const,
    reason: 'effort_mapped' as const,
  };
  const rejection = JSON.stringify({
    error: {
      code: 'request_rejected',
      message:
        '{"object":"error","message":{"detail":[{"type":"extra_forbidden","loc":["body","reasoning"],"msg":"Extra inputs are not permitted"}]}}',
    },
  });

  beforeEach(() => clearSurplusReasoningRejections());

  it('never sends reasoning to providers known to reject extra fields', () => {
    expect(surplusReasoningBody(resolution, true, 'mistral')).toEqual({});
    expect(surplusReasoningBody(resolution, true, 'dashscope-cn')).toEqual({
      reasoning: { effort: 'medium' },
    });
  });

  it('recognizes the reasoning rejection and only that', () => {
    expect(isSurplusReasoningRejection(400, rejection)).toBe(true);
    expect(isSurplusReasoningRejection(404, rejection)).toBe(false);
    expect(isSurplusReasoningRejection(400, '{"error":{"code":"request_rejected"}}')).toBe(false);
  });

  it('learns a rejecting provider from a 400 and stops sending reasoning to it for a while', async () => {
    const response = new Response(rejection, { status: 400 });
    await learnSurplusReasoningRejection(response, 'novel-provider');
    expect(await response.text()).toBe(rejection);
    expect(surplusReasoningBody(resolution, false, 'novel-provider')).toEqual({});
    expect(surplusReasoningAccepted('novel-provider', Date.now() + 7 * 60 * 60 * 1000)).toBe(true);
    noteSurplusReasoningRejected('other', 0);
    expect(surplusReasoningAccepted('other', 1)).toBe(false);
  });
});
