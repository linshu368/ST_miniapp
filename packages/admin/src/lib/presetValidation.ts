const EFFECTIVE_PRESET_KEYS = new Set([
  'temperature',
  'frequency_penalty',
  'presence_penalty',
  'top_p',
  'top_k',
  'top_a',
  'min_p',
  'repetition_penalty',
  'max_context_unlocked',
  'tool_reasoning_mode',
  'openai_max_context',
  'openai_max_tokens',
  'names_behavior',
  'send_if_empty',
  'impersonation_prompt',
  'new_chat_prompt',
  'new_group_chat_prompt',
  'new_example_chat_prompt',
  'continue_nudge_prompt',
  'bias_preset_selected',
  'wi_format',
  'scenario_format',
  'personality_format',
  'group_nudge_prompt',
  'stream_openai',
  'prompts',
  'prompt_order',
  'assistant_prefill',
  'assistant_impersonation',
  'use_sysprompt',
  'squash_system_messages',
  'media_inlining',
  'inline_image_quality',
  'continue_prefill',
  'continue_postfix',
  'function_calling',
  'tool_call_recurse_limit',
  'show_thoughts',
  'reasoning_effort',
  'verbosity',
  'enable_web_search',
  'seed',
  'n',
  'request_images',
  'request_image_aspect_ratio',
  'request_image_resolution',
  'extensions',
]);

const CONNECTION_KEY_PATTERN =
  /(^|_)(api_key|model)$|^(chat_completion_source|custom_url|reverse_proxy|proxy_password|openrouter_|azure_|vertex_|workers_ai_)/;
const MERGER_OVERRIDDEN_KEYS = new Set(['openai_max_context', 'max_context_unlocked']);
const MAX_PRESET_BYTES = 1024 * 1024;

export interface PresetAnalysis {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    bytes: number;
    keyCount: number;
    promptCount: number;
    orderedPromptCount: number;
    extensionCount: number;
    promptIdentifiers: string[];
    sampling: Record<string, number>;
    effectiveKeys: string[];
    ignoredKeys: string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function countExtensions(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  return 0;
}

export function analyzePresetPayload(value: unknown): PresetAnalysis {
  const errors: string[] = [];
  const warnings: string[] = [];
  const emptySummary = {
    bytes: 0,
    keyCount: 0,
    promptCount: 0,
    orderedPromptCount: 0,
    extensionCount: 0,
    promptIdentifiers: [] as string[],
    sampling: {} as Record<string, number>,
    effectiveKeys: [] as string[],
    ignoredKeys: [] as string[],
  };

  if (!isRecord(value)) {
    return {
      valid: false,
      errors: ['预设内容必须是 JSON 对象，不能是数组或普通值。'],
      warnings,
      summary: emptySummary,
    };
  }

  const bytes = byteLength(value);
  if (bytes > MAX_PRESET_BYTES) {
    errors.push('预设内容超过 1 MB，无法发布。');
  }

  const prompts = value.prompts;
  const promptIdentifiers = new Set<string>();
  if (prompts !== undefined && !Array.isArray(prompts)) {
    errors.push('prompts 必须是数组。');
  } else if (Array.isArray(prompts)) {
    prompts.forEach((prompt, index) => {
      if (!isRecord(prompt) || typeof prompt.identifier !== 'string' || !prompt.identifier.trim()) {
        errors.push(`prompts[${index}] 缺少有效的 identifier。`);
        return;
      }
      if (promptIdentifiers.has(prompt.identifier)) {
        errors.push(`prompts 中存在重复 identifier：${prompt.identifier}。`);
      }
      promptIdentifiers.add(prompt.identifier);
    });
  }

  const promptOrder = value.prompt_order;
  let orderedPromptCount = 0;
  if (promptOrder !== undefined && !Array.isArray(promptOrder)) {
    errors.push('prompt_order 必须是数组。');
  } else if (Array.isArray(promptOrder)) {
    promptOrder.forEach((group, groupIndex) => {
      if (!isRecord(group) || !Array.isArray(group.order)) {
        errors.push(`prompt_order[${groupIndex}].order 必须是数组。`);
        return;
      }
      group.order.forEach((item, itemIndex) => {
        if (!isRecord(item) || typeof item.identifier !== 'string' || !item.identifier.trim()) {
          errors.push(`prompt_order[${groupIndex}].order[${itemIndex}] 缺少 identifier。`);
          return;
        }
        if (item.enabled !== false) orderedPromptCount += 1;
        if (promptIdentifiers.size > 0 && !promptIdentifiers.has(item.identifier)) {
          warnings.push(`prompt_order 引用了 prompts 中不存在的 ${item.identifier}。`);
        }
      });
    });
  }

  const keys = Object.keys(value);
  const effectiveKeys = keys.filter((key) => EFFECTIVE_PRESET_KEYS.has(key));
  const ignoredKeys = keys.filter((key) => !EFFECTIVE_PRESET_KEYS.has(key));
  const connectionKeys = ignoredKeys.filter((key) => CONNECTION_KEY_PATTERN.test(key));
  if (connectionKeys.length > 0) {
    warnings.push(`连接或模型字段不会生效：${connectionKeys.join('、')}。`);
  }
  const overriddenKeys = keys.filter((key) => MERGER_OVERRIDDEN_KEYS.has(key));
  if (overriddenKeys.length > 0) {
    warnings.push(`${overriddenKeys.join('、')} 会被平台同步链路的固定值覆盖。`);
  }
  if (effectiveKeys.length === 0) {
    errors.push('当前 JSON 没有同步链路可识别的预设字段，不能发布。');
  }
  const samplingKeys = [
    'temperature',
    'frequency_penalty',
    'presence_penalty',
    'top_p',
    'top_k',
    'top_a',
    'min_p',
    'repetition_penalty',
    'openai_max_tokens',
  ];
  const sampling = Object.fromEntries(
    samplingKeys.flatMap((key) =>
      typeof value[key] === 'number' ? [[key, value[key] as number]] : []
    )
  );

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      bytes,
      keyCount: keys.length,
      promptCount: Array.isArray(prompts) ? prompts.length : 0,
      orderedPromptCount,
      extensionCount: countExtensions(value.extensions),
      promptIdentifiers: [...promptIdentifiers],
      sampling,
      effectiveKeys,
      ignoredKeys,
    },
  };
}

export function parsePresetJson(source: string): {
  value: Record<string, unknown> | null;
  analysis: PresetAnalysis;
} {
  try {
    const value: unknown = JSON.parse(source);
    const analysis = analyzePresetPayload(value);
    return { value: isRecord(value) ? value : null, analysis };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'JSON 解析失败';
    return {
      value: null,
      analysis: {
        valid: false,
        errors: [`JSON 格式错误：${message}`],
        warnings: [],
        summary: {
          bytes: new TextEncoder().encode(source).byteLength,
          keyCount: 0,
          promptCount: 0,
          orderedPromptCount: 0,
          extensionCount: 0,
          promptIdentifiers: [],
          sampling: {},
          effectiveKeys: [],
          ignoredKeys: [],
        },
      },
    };
  }
}
