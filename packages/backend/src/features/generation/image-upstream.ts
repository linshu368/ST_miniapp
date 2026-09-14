import { MAX_IMAGE_PROMPT_CHARS } from '@miniapp/shared';
import type { CharacterCardRow } from '../../infrastructure/repositories/CharacterCardRepository.js';
import type {
  ConversationContext,
  ConversationHistoryRow,
} from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { config } from '../../platform/config.js';
import type { ImageRuntimeConfig } from '../image/config.js';

const DESCRIPTION_SYSTEM_PROMPT = [
  '你是视觉分镜师，只为健康、可公开发布的角色聊天图片写中文画面描述。',
  '输出 1 句中文短文，不超过 200 字。',
  '只描述画面中可见的角色、姿态、表情、服饰、场景、光影和构图。',
  '不要写解释、编号、引号、Markdown，不要加入露骨、暴力或未成年人性化内容。',
  '不得改变角色核心外貌锚点。',
].join('\n');

const TRANSLATE_SYSTEM_PROMPT = [
  '你是文生图提示词翻译。',
  '把中文场景描述直译成英文文生图提示词。',
  '完整保留人物特征、动作姿态、场景、情绪、画面风格，不增删内容。',
  '只输出英文，不要解释。',
].join('\n');

export class ImageUpstreamError extends Error {
  constructor(
    readonly stage: 'description' | 'translation' | 'provider' | 'download',
    readonly code: string,
    message: string,
    readonly unknownOutcome = false
  ) {
    super(message);
    this.name = 'ImageUpstreamError';
  }
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

interface GrokImageResponse {
  data?: { url?: string }[];
  error?: { message?: string };
}

interface ReplicatePredictionResponse {
  id?: string;
  status?: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

export interface GeneratedProviderImage {
  url: string;
  provider: 'liaobots_grok' | 'replicate_z';
  model: string;
  requestId: string | null;
}

export function requireVisualAnchor(character: CharacterCardRow): string {
  const anchor = character.character_persona_and_style?.trim();
  if (!anchor) {
    throw new ImageUpstreamError(
      'description',
      'image_character_visual_unavailable',
      '角色缺少可用于出图的视觉锚点'
    );
  }
  return anchor;
}

/** 默认路径写中文短文；自定义路径不会调用它。 */
export async function draftImageDescription(input: {
  character: CharacterCardRow;
  visualAnchor: string;
  context: ConversationContext;
  turn: ConversationHistoryRow;
  imageConfig: ImageRuntimeConfig;
}): Promise<string> {
  const userPrompt = [
    `【生成风格】：${input.imageConfig.defaultArtStyle}`,
    `【角色名】：${input.character.name}`,
    `【角色基础长相设定】：\n${input.visualAnchor}`,
    `【必要角色卡信息】：\n${compactCharacterNotes(input.character)}`,
    `【最近对话上下文】：\n${formatRecentMessages(input.context, input.turn)}`,
  ].join('\n\n');

  const text = normalizePromptText(
    await callDeepSeek(DESCRIPTION_SYSTEM_PROMPT, userPrompt, 'description')
  );
  if (!text || text.length > MAX_IMAGE_PROMPT_CHARS) {
    throw new ImageUpstreamError(
      'description',
      'image_description_unusable',
      '图片描述为空或超过上限'
    );
  }
  return text;
}

/** 将用户确认的中文稿直译为 provider 输入，不执行图片领域润色。 */
export async function translateImagePrompt(promptCn: string): Promise<string> {
  const translated = normalizePromptText(
    await callDeepSeek(TRANSLATE_SYSTEM_PROMPT, promptCn, 'translation')
  );
  if (!translated) {
    throw new ImageUpstreamError('translation', 'image_translation_failed', '图片描述翻译为空');
  }
  return translated;
}

export function buildProviderPrompt(input: {
  visualAnchor: string;
  promptEn: string;
  imageConfig: ImageRuntimeConfig;
}): string {
  return [
    'Vertical illustration.',
    `Character anchor: ${input.visualAnchor}`,
    `Scene: ${input.promptEn}`,
    `Style and safety: ${input.imageConfig.defaultArtStyle}. ${input.imageConfig.promptPolicy}`,
  ].join('\n');
}

/** Z 降级模型使用紧凑 tag 结构；只重排相同的角色锚点和场景，不补充新画面内容。 */
export function buildZProviderPrompt(input: { visualAnchor: string; promptEn: string }): string {
  return `${input.visualAnchor}, ${input.promptEn}`;
}

/** 调用 Grok 图片 POST；网络超时属于结果未知，调用方不得自动重投。 */
export async function generateGrokImage(input: {
  prompt: string;
  width: number;
  height: number;
}): Promise<string> {
  if (!config.image.liaobotsAuth || !config.image.liaobotsBase || !config.image.grokModel) {
    throw new ImageUpstreamError('provider', 'image_generation_not_allowed', '图片服务未配置');
  }

  let response: Response;
  try {
    response = await fetch(
      `${config.image.liaobotsBase.replace(/\/+$/, '')}/v1/images/generations`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.image.liaobotsAuth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.image.grokModel,
          prompt: input.prompt,
          n: 1,
          size: `${input.width}x${input.height}`,
        }),
        signal: AbortSignal.timeout(config.image.timeoutMs),
      }
    );
  } catch (error) {
    throw toImageTransportError('provider', error, true);
  }

  let body: GrokImageResponse;
  try {
    body = (await response.json()) as GrokImageResponse;
  } catch {
    throw new ImageUpstreamError(
      'provider',
      'image_provider_bad_response',
      '图片服务返回无法解析的内容'
    );
  }
  if (!response.ok) {
    throw new ImageUpstreamError(
      'provider',
      `image_provider_${response.status}`,
      body.error?.message || `图片服务返回 HTTP ${response.status}`
    );
  }
  const url = body.data?.[0]?.url;
  if (!url) {
    throw new ImageUpstreamError('provider', 'image_provider_empty', '图片服务没有返回图片 URL');
  }
  return url;
}

/**
 * 调用 Replicate Z 模型。创建 prediction 不重试，避免响应丢失后重复生图；仅轮询其 GET 状态。
 * 返回 URL 仍交给统一 Storage 下载防护，不信任 provider 输出。
 */
export async function generateZImage(input: {
  prompt: string;
  width: number;
  height: number;
}): Promise<GeneratedProviderImage> {
  const { replicateToken, replicateBase, zModel } = config.image;
  const [owner, name, ...extra] = zModel.split('/');
  if (!replicateToken || !owner || !name || extra.length > 0) {
    throw new ImageUpstreamError('provider', 'image_generation_not_allowed', 'Z 图片服务未配置');
  }

  const deadlineAt = Date.now() + config.image.timeoutMs;
  const endpoint = `${replicateBase.replace(/\/+$/, '')}/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions`;
  let prediction = await requestReplicatePrediction(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${replicateToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=60',
    },
    body: JSON.stringify({
      input: {
        width: input.width,
        height: input.height,
        prompt: input.prompt,
        go_fast: true,
        output_format: 'jpg',
        guidance_scale: 0,
        output_quality: 90,
        num_inference_steps: 8,
      },
    }),
    signal: AbortSignal.timeout(config.image.timeoutMs),
  });

  while (prediction.status === 'starting' || prediction.status === 'processing') {
    const getUrl = prediction.urls?.get;
    if (!getUrl) {
      throw new ImageUpstreamError(
        'provider',
        'image_provider_bad_response',
        'Z 图片服务缺少查询地址'
      );
    }
    assertReplicatePollingUrl(getUrl, replicateBase);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new ImageUpstreamError(
        'provider',
        'image_provider_timeout_unknown',
        'Z 图片服务等待超时',
        true
      );
    }
    await delay(Math.min(1_500, remainingMs));
    prediction = await requestReplicatePrediction(getUrl, {
      headers: { Authorization: `Bearer ${replicateToken}` },
      signal: AbortSignal.timeout(remainingMs),
    });
  }

  if (prediction.status !== 'succeeded') {
    throw new ImageUpstreamError(
      'provider',
      `image_provider_z_${prediction.status ?? 'bad_response'}`,
      'Z 图片服务生成失败'
    );
  }
  const url = readReplicateOutputUrl(prediction.output);
  if (!url)
    throw new ImageUpstreamError('provider', 'image_provider_empty', 'Z 图片服务没有返回图片 URL');
  return { url, provider: 'replicate_z', model: zModel, requestId: prediction.id ?? null };
}

/** 防止异常 provider 响应诱导后端把 Replicate token 发往其他域名。 */
function assertReplicatePollingUrl(value: string, replicateBase: string): void {
  try {
    const target = new URL(value);
    const expected = new URL(replicateBase);
    if (target.protocol === 'https:' && target.origin === expected.origin) return;
  } catch {
    // 统一在下方以脱敏业务错误收口，不把原始 URL 写日志。
  }
  throw new ImageUpstreamError(
    'provider',
    'image_provider_bad_response',
    'Z 图片服务返回了不可信的查询地址'
  );
}

async function requestReplicatePrediction(
  url: string,
  init: RequestInit
): Promise<ReplicatePredictionResponse> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw toImageTransportError('provider', error, true);
  }
  let body: ReplicatePredictionResponse;
  try {
    body = (await response.json()) as ReplicatePredictionResponse;
  } catch {
    throw new ImageUpstreamError(
      'provider',
      'image_provider_bad_response',
      'Z 图片服务返回无法解析的内容'
    );
  }
  if (!response.ok) {
    throw new ImageUpstreamError(
      'provider',
      `image_provider_z_${response.status}`,
      `Z 图片服务返回 HTTP ${response.status}`
    );
  }
  return body;
}

function readReplicateOutputUrl(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const first = output.find((item): item is string => typeof item === 'string');
    return first ?? null;
  }
  if (output && typeof output === 'object' && 'url' in output) {
    const url = (output as { url?: unknown }).url;
    return typeof url === 'string' ? url : null;
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** DeepSeek 普通文本调用复用语音既有配置，但不复用语音专属清洗逻辑。 */
async function callDeepSeek(
  systemPrompt: string,
  userPrompt: string,
  stage: 'description' | 'translation'
): Promise<string> {
  if (!config.voice.draft.apiKey || !config.voice.draft.url || !config.voice.draft.model) {
    throw new ImageUpstreamError(stage, 'image_generation_not_allowed', 'DeepSeek 未配置');
  }
  let response: Response;
  try {
    response = await fetch(config.voice.draft.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.voice.draft.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.voice.draft.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.6,
        max_tokens: 1200,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(config.voice.timeoutMs),
    });
  } catch (error) {
    throw toImageTransportError(stage, error, false);
  }
  let body: ChatCompletionResponse;
  try {
    body = (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new ImageUpstreamError(
      stage,
      `image_${stage}_bad_response`,
      'DeepSeek 返回无法解析的内容'
    );
  }
  if (!response.ok) {
    throw new ImageUpstreamError(
      stage,
      stage === 'description' ? `image_description_${response.status}` : 'image_translation_failed',
      body.error?.message || `DeepSeek 返回 HTTP ${response.status}`
    );
  }
  return body.choices?.[0]?.message?.content ?? '';
}

function compactCharacterNotes(character: CharacterCardRow): string {
  return [
    character.description ? `description: ${character.description}` : '',
    character.personality ? `personality: ${character.personality}` : '',
    character.scenario ? `scenario: ${character.scenario}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1600);
}

function formatRecentMessages(context: ConversationContext, turn: ConversationHistoryRow): string {
  const messages = [
    ...context.messages,
    { role: 'assistant' as const, content: turn.assistant_reply ?? '' },
  ]
    .filter((message) => message.content.trim())
    .slice(-8);
  return messages.map((message) => `${message.role}: ${message.content.trim()}`).join('\n');
}

function normalizePromptText(value: string): string {
  return value
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function toImageTransportError(
  stage: 'description' | 'translation' | 'provider' | 'download',
  error: unknown,
  unknownOutcome: boolean
): ImageUpstreamError {
  const code =
    stage === 'provider'
      ? isTimeoutError(error)
        ? 'image_provider_timeout_unknown'
        : 'image_provider_network_unknown'
      : stage === 'translation'
        ? 'image_translation_failed'
        : `image_${stage}_timeout`;
  return new ImageUpstreamError(
    stage,
    code,
    error instanceof Error ? error.message : '图片链路上游请求失败',
    unknownOutcome
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
