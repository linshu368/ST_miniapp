import { MAX_IMAGE_PROMPT_CHARS } from '@miniapp/shared';
import { Buffer } from 'node:buffer';
import type { StoredImageMimeType } from '../../lib/chat-image-storage.js';
import type { CharacterCardRow } from '../../infrastructure/repositories/CharacterCardRepository.js';
import type {
  ConversationContext,
  ConversationHistoryRow,
} from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { config } from '../../platform/config.js';
import type { ImageRuntimeConfig } from '../image/config.js';
import type { ImageTextModelConfig } from '../image/config.js';

// const DESCRIPTION_SYSTEM_PROMPT = [
//   '你是视觉分镜师，只为健康、可公开发布的角色聊天图片写中文画面描述。',
//   '输出 1 句中文短文，不超过 200 字。',
//   '只描述画面中可见的角色、姿态、表情、服饰、场景、光影和构图。',
//   '不要写解释、编号、引号、Markdown，不要加入露骨、暴力或未成年人性化内容。',
//   '不得改变角色核心外貌锚点。',
// ].join('\n');
const DESCRIPTION_SYSTEM_PROMPT = `
角色与目标
你是一个顶级的视觉分镜师与写实风格图片的文生图提示词专家。
你的任务不是套用某种固定风格（比如"必须暧昧"或"必须视觉炫技"），而是先判断当前这段对话真实所处的情感与氛围阶段，再据此写出与这个阶段真正相符的图像生成提示词。画面服务于对话本身的真实语境，不能脱离语境主观加戏。
---
第一步：阶段判断（内部完成，不输出）
在动笔写提示词之前，先根据【最近对话上下文】的文本判断当前所处的阶段。以下类型供参考，不是穷尽分类，实际以对话真实语气为准：
• 日常/平淡场景：普通闲聊、日常活动，情绪平和。画面自然克制，不需要任何暧昧或视觉张力元素，重点是还原真实的生活状态。
• 情绪升温/关系靠近：语气变暖、有轻微调情或情感拉近，但没有明确身体暗示。画面可带一点若有若无的柔和氛围，幅度很小。
• 强烈暧昧/临界状态：对话已明确进入撩人、身体接触暗示、亲密行为语境。画面可以大胆呈现擦边、诱惑与张力，把遐想空间拉满。
• 负面/紧张情绪（冲突、难过、疲惫、压力等）：画面必须服务于情绪本身，可以压抑、疏离、沉重，绝对不能强行加入性张力或美化元素，这会显得违和且冒犯。
• 特定行动场景（运动、工作、探险、日常任务等）：画面服务于动作本身的力度和真实感，不需要任何暗示性处理，重点在动作是否可信、场景是否合理。
判断的唯一依据是对话中呈现出的真实语气、动作走向和情绪状态，不能凭空拔高或降低尺度。
---
第二步：角色形象的处理方式（关键）
【角色基础形象设定】中包含两类信息，处理方式完全不同：
1. 核心识别特征（不可变，必须逐字保留）调用该角色{character_persona_and_style} 字段
此字段为固定调用用于锚定角色核心特征如发色，瞳孔脸型，身高等，不可更改
2. 可变呈现状态（随场景自由生成，不需要参照默认设定）包括发型是否整齐凌乱、妆感、配饰佩戴与否、表情神态、姿态动作、当下穿着。这部分完全由【最近对话上下文】里的实际情境决定，不受角色基础形象设定里任何默认描述的约束——如果对话暗示头发凌乱、衣着不整，就按对话来写，不需要保持"整齐"这种默认状态。如果对话完全没有提供任何相关线索，可参考【角色基础形象设定】中的默认风格作兜底，避免画面空洞。
融合原则：把第1类的核心特征，自然地编织进当前场景的动作和神态描写中（分布式嵌入，而不是集中堆砌在开头），第2类的呈现状态完全根据对话情境自由生成。整段读起来应该是一段连贯流畅的场景描写，而不是"人设卡朗读+场景卡朗读"的拼接感。
---
第三步：依据阶段判断结果撰写场景与镜头语言
• 【高颜值铁律·始终生效】 无论判断出什么阶段、无论角色是男是女（含伪娘、机械人等特殊设定），画面主体必须是好看的——五官精致、面容美型、气质出众、颜值高。这是产品的核心卖点，不随阶段浮动。负面/压抑场景下，是"好看的人在承受情绪"，光影可以压抑，但人物本身绝不能丑；伪娘类角色尤其要美型，禁止画成普通男性脸。
• 【非主角/NPC 兜底】 当画面里出现【角色基础形象设定】未覆盖的角色（NPC、路人、次要角色）时，不要因为没有其具体外貌字段就画糊画丑——默认赋予「基本高颜值」：五官精致、面容美型、颜值高。主角与所有非主角角色都必须好看。
• 镜头语言与光影的"精致程度"要跟随阶段浮动，不是每次都用最高强度的电影级描写。日常场景可以用轻松自然的构图和光线，不需要堆砌"电影级质感、浅景深、胶片颗粒"这类词汇；只有当阶段本身确实需要氛围渲染（比如强烈暧昧或情绪浓烈的场景）时，才动用更讲究的镜头语言去强化它。
• 是否包含暗示性描写完全取决于阶段判断。如果当前对话没有任何暧昧成分，就不要主动添加咬唇、湿发、衣物松垮之类的暗示元素——这类描写只在判断结果确实指向亲密/暧昧阶段时才使用，当内容明确提及色情内容与场景，则需要直接进行相应拆解输出
• 核心检验标准：这张图放在这段对话后面，用户会不会觉得"违和"或"用力过猛"。如果会，说明画面强度和阶段没对上，需要往回收。
• 最终提示词必须体现【写实生成风格】所指定的画面风格，风格关键词应该自然融入镜头语言描述中
---
输出格式
直接输出最终的中文图像生成提示词本身，不要输出阶段判断过程、分析或任何解释性文字。要求语法完整、画面感强、是自然流畅的一段连贯描写（不是分段罗列，也不是关键词堆砌），角色核心识别特征与当前场景动作要读起来像同一段描写自然带出，句子的精致程度跟随阶段浮动，不必每次都追求视觉炫技。
---
输入信息格式

`;

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
  data?: { b64_json?: string; media_type?: string; url?: string }[];
  error?: { message?: string };
}

interface ReplicatePredictionResponse {
  id?: string;
  status?: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

export type GeneratedProviderImage =
  | {
      source: 'url';
      url: string;
      provider: 'liaobots_grok' | 'replicate_z';
      model: string;
      requestId: string | null;
    }
  | {
      source: 'bytes';
      bytes: Buffer;
      mimeType: StoredImageMimeType;
      provider: 'liaobots_grok' | 'replicate_z';
      model: string;
      requestId: string | null;
    };

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
  persistUserPrompt: (userPrompt: string) => Promise<void>;
}): Promise<string> {
  const userPrompt = [
    `【生成风格】：${input.imageConfig.defaultArtStyle}`,
    `【角色名】：${input.character.name}`,
    `【角色基础长相设定】：\n${input.visualAnchor}`,
    `【必要角色卡信息】：\n${compactCharacterNotes(input.character)}`,
    `【最近对话上下文】：\n${formatRecentMessages(input.context, input.turn)}`,
  ].join('\n\n');
  // 审计写入是调用上游的前置提交点；失败时不得产生无记录的模型请求。
  await input.persistUserPrompt(`${DESCRIPTION_SYSTEM_PROMPT}\n\n${userPrompt}`);
  const text = normalizePromptText(
    await callDeepSeek(
      DESCRIPTION_SYSTEM_PROMPT,
      userPrompt,
      'description',
      input.imageConfig.textModel
    )
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
export async function translateImagePrompt(
  promptCn: string,
  textModel: ImageTextModelConfig
): Promise<string> {
  const translated = normalizePromptText(
    await callDeepSeek(TRANSLATE_SYSTEM_PROMPT, promptCn, 'translation', textModel)
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
}): Promise<GeneratedProviderImage> {
  if (!config.image.liaobotsAuth || !config.image.liaobotsBase || !config.image.grokModel) {
    throw new ImageUpstreamError('provider', 'image_generation_not_allowed', '图片服务未配置');
  }

  let response: Response;
  try {
    response = await fetch(`${config.image.liaobotsBase}`, {
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
    });
  } catch (error) {
    throw toImageTransportError('provider', error, true);
  }

  console.log('response', response);
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
  const firstImage = body.data?.[0];
  const metadata = {
    provider: 'liaobots_grok' as const,
    model: config.image.grokModel,
    requestId: null,
  };
  const url = firstImage?.url;
  if (url) return { source: 'url', url, ...metadata };
  const b64Json = firstImage?.b64_json;
  if (b64Json) {
    const bytes = decodeBase64Image(b64Json);
    const mimeType =
      normalizeGeneratedMimeType(firstImage?.media_type) ?? inferImageMimeType(bytes);
    if (!mimeType) {
      throw new ImageUpstreamError(
        'provider',
        'image_provider_bad_response',
        '图片服务返回了不支持的图片类型'
      );
    }
    return { source: 'bytes', bytes, mimeType, ...metadata };
  }
  throw new ImageUpstreamError('provider', 'image_provider_empty', '图片服务没有返回图片 URL');
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
  return {
    source: 'url',
    url,
    provider: 'replicate_z',
    model: zModel,
    requestId: prediction.id ?? null,
  };
}

function resolveLiaobotsImageEndpoint(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/images/generations')) return trimmed;
  return `${trimmed}/v1/images/generations`;
}

function normalizeGeneratedMimeType(value: string | undefined): StoredImageMimeType | null {
  const mime = value?.split(';')[0]?.trim().toLowerCase();
  return mime === 'image/webp' || mime === 'image/png' || mime === 'image/jpeg' ? mime : null;
}

function inferImageMimeType(bytes: Buffer): StoredImageMimeType | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function decodeBase64Image(value: string): Buffer {
  const normalized = value.trim().replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new ImageUpstreamError(
      'provider',
      'image_provider_bad_response',
      '图片服务返回了无法解析的图片内容'
    );
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.byteLength === 0) {
    throw new ImageUpstreamError('provider', 'image_provider_empty', '图片服务没有返回图片内容');
  }
  return bytes;
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

/** OpenAI-compatible 普通文本调用；默认回退现有 DeepSeek 配置。 */
async function callDeepSeek(
  systemPrompt: string,
  userPrompt: string,
  stage: 'description' | 'translation',
  textModel: ImageTextModelConfig
): Promise<string> {
  if (!textModel.apiKey || !textModel.url || !textModel.model) {
    throw new ImageUpstreamError(stage, 'image_generation_not_allowed', 'DeepSeek 未配置');
  }
  let response: Response;
  try {
    response = await fetch(textModel.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${textModel.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: textModel.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.6,
        max_tokens: 1200,
        ...(isOpenRouterUrl(textModel.url)
          ? { reasoning: { enabled: true } }
          : { thinking: { type: 'disabled' } }),
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

function isOpenRouterUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === 'openrouter.ai';
  } catch {
    return false;
  }
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
