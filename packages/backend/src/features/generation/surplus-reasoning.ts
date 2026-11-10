import {
  getProviderModelDirectory,
  getCachedSurplusModelDirectory,
} from '../../platform/model-provider-directory.js';

export interface SurplusReasoningResolution {
  parameters: Record<string, never>;
  supportedParameters: string[];
  requestedEnabled: boolean;
  control: 'provider_default' | 'unavailable';
  reason: 'effort_values_unspecified' | 'unsupported' | 'directory_unavailable';
}

/** The catalog exposes knob names, not valid values. A UI boolean cannot safely invent effort. */
export async function getSurplusReasoningParameters(
  modelId: string,
  enabled: boolean,
  options: { cachedOnly?: boolean } = {}
): Promise<SurplusReasoningResolution> {
  try {
    const directory = options.cachedOnly
      ? getCachedSurplusModelDirectory()
      : await getProviderModelDirectory('surplus');
    if (!directory)
      return {
        parameters: {},
        supportedParameters: [],
        requestedEnabled: enabled,
        control: 'unavailable',
        reason: 'directory_unavailable',
      };
    const supportedParameters =
      directory.models.find((model) => model.id === modelId)?.supported_parameters ?? [];
    const declaresReasoning = supportedParameters.some(
      (name) => name === 'reasoning' || name === 'reasoning_effort'
    );
    // Surplus documents that include_reasoning is stripped on the chat wire, and
    // neither reasoning.enabled nor high/none is universally accepted by sellers.
    return {
      parameters: {},
      supportedParameters,
      requestedEnabled: enabled,
      control: declaresReasoning ? 'provider_default' : 'unavailable',
      reason: declaresReasoning ? 'effort_values_unspecified' : 'unsupported',
    };
  } catch {
    return {
      parameters: {},
      supportedParameters: [],
      requestedEnabled: enabled,
      control: 'unavailable',
      reason: 'directory_unavailable',
    };
  }
}
