/** preset_payload key → oai_settings key（不包含连接、鉴权和模型字段） */
export const PRESET_TO_OAI_SETTINGS: Readonly<Record<string, string>> = {
  temperature: 'temp_openai',
  frequency_penalty: 'freq_pen_openai',
  presence_penalty: 'pres_pen_openai',
  top_p: 'top_p_openai',
  top_k: 'top_k_openai',
  top_a: 'top_a_openai',
  min_p: 'min_p_openai',
  repetition_penalty: 'repetition_penalty_openai',
  max_context_unlocked: 'max_context_unlocked',
  tool_reasoning_mode: 'tool_reasoning_mode',
  openai_max_context: 'openai_max_context',
  openai_max_tokens: 'openai_max_tokens',
  names_behavior: 'names_behavior',
  send_if_empty: 'send_if_empty',
  impersonation_prompt: 'impersonation_prompt',
  new_chat_prompt: 'new_chat_prompt',
  new_group_chat_prompt: 'new_group_chat_prompt',
  new_example_chat_prompt: 'new_example_chat_prompt',
  continue_nudge_prompt: 'continue_nudge_prompt',
  bias_preset_selected: 'bias_preset_selected',
  wi_format: 'wi_format',
  scenario_format: 'scenario_format',
  personality_format: 'personality_format',
  group_nudge_prompt: 'group_nudge_prompt',
  stream_openai: 'stream_openai',
  prompts: 'prompts',
  prompt_order: 'prompt_order',
  assistant_prefill: 'assistant_prefill',
  assistant_impersonation: 'assistant_impersonation',
  use_sysprompt: 'use_sysprompt',
  squash_system_messages: 'squash_system_messages',
  media_inlining: 'media_inlining',
  inline_image_quality: 'inline_image_quality',
  continue_prefill: 'continue_prefill',
  continue_postfix: 'continue_postfix',
  function_calling: 'function_calling',
  tool_call_recurse_limit: 'tool_call_recurse_limit',
  show_thoughts: 'show_thoughts',
  reasoning_effort: 'reasoning_effort',
  verbosity: 'verbosity',
  enable_web_search: 'enable_web_search',
  seed: 'seed',
  n: 'n',
  request_images: 'request_images',
  request_image_aspect_ratio: 'request_image_aspect_ratio',
  request_image_resolution: 'request_image_resolution',
  extensions: 'extensions',
};

export function toPresetOaiSettingsPatch(
  presetPayload: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [presetKey, oaiKey] of Object.entries(PRESET_TO_OAI_SETTINGS)) {
    if (presetPayload[presetKey] !== undefined) {
      patch[oaiKey] = presetPayload[presetKey];
    }
  }
  return patch;
}

export function toSafePresetPayload(
  presetPayload: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(PRESET_TO_OAI_SETTINGS)
      .filter((key) => presetPayload[key] !== undefined)
      .map((key) => [key, presetPayload[key]])
  );
}
