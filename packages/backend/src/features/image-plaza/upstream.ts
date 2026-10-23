import { Buffer } from 'node:buffer';
import { createLogger } from '../../lib/logger.js';
import { config } from '../../platform/config.js';
import { veniceFetch } from '../../platform/venice-http.js';
import type { PlazaMimeType } from './storage.js';

const MAX_PROVIDER_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * Venice 内容策略拦截时常返回纯色/模糊占位 webp（实测约 1–2KB）。
 * 低于此阈值视为未出有效图，按内容拒绝处理且不进入结算扣费。
 */
const MIN_ACCEPTABLE_PROVIDER_IMAGE_BYTES = 4 * 1024;
/** A1111 / WebUI 风格扩展标签；Venice 不支持，保留会触发 content-violation 黑图。 */
const UNSUPPORTED_PROMPT_TAG_RE = /<(?:lora|lyco|hypernet):[^>\n]+>/gi;
const log = createLogger('image-plaza-upstream');

/** 响应头值通常很短；设上限避免异常头撑大日志。 */
const MAX_LOGGED_HEADER_VALUE_LENGTH = 200;

/**
 * 发送 Venice 前去掉不支持的 LoRA/LyCORIS/Hypernetwork 尖括号标签，并压缩多余空白。
 * 只改出站 prompt，不回写用户原文。
 */
export function stripUnsupportedImagePlazaPromptTags(prompt: string): string {
  return prompt
    .replace(UNSUPPORTED_PROMPT_TAG_RE, ' ')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 采集 Venice 响应头用于排查黑图/模糊/审核拦截（x-venice-is-content-violation、
 * x-venice-is-blurred 等）。按 `x-venice-` 前缀整体采集，这样 Venice 新增的头无需改代码。
 * x-venice-enhanced-prompt 是用户 prompt 的改写结果，可能含敏感内容，只记录长度。
 */
function collectProviderHeaders(headers: Headers): Record<string, string | number> {
  const collected: Record<string, string | number> = {};
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (key === 'x-venice-enhanced-prompt') {
      collected['x-venice-enhanced-prompt-length'] = value.length;
    } else if (key.startsWith('x-venice-') || key === 'x-request-id' || key === 'content-type') {
      collected[key] = value.slice(0, MAX_LOGGED_HEADER_VALUE_LENGTH);
    }
  });
  return collected;
}

export class ImagePlazaUpstreamError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUnknown: boolean,
    message = code
  ) {
    super(message);
  }
}

export interface ImagePlazaGenerationInput {
  providerModelId: string;
  prompt: string;
  aspectRatio: string;
  resolution: '1K' | '2K' | 'fixed';
  sizingMode: 'aspect_ratio' | 'resolution' | 'pixels';
  mode: 't2i' | 'i2i' | 'edit';
  /** 对应 Venice enhance_prompt；仅 generate 生效，edit 端点不接受该字段。 */
  autoOptimize?: boolean;
  reference?: { bytes: Buffer; mimeType: PlazaMimeType };
}

export interface ImagePlazaGeneratedImage {
  bytes: Buffer;
  mimeType: PlazaMimeType;
  providerRequestId: string | null;
}

/** Venice 图片调用不自动重试：请求发出后的网络错误属于结果未知，重投可能重复计费。 */
export async function generateImagePlazaImage(
  input: ImagePlazaGenerationInput
): Promise<ImagePlazaGeneratedImage> {
  if (!config.imagePlaza.apiKey) {
    throw new ImagePlazaUpstreamError('image_plaza_provider_not_configured', false);
  }
  if (input.mode !== 't2i' && !input.reference) {
    throw new ImagePlazaUpstreamError('image_plaza_reference_missing', false);
  }

  const isEdit = input.mode !== 't2i';
  const hadUnsupportedTags = /<(?:lora|lyco|hypernet):[^>\n]+>/i.test(input.prompt);
  const prompt = stripUnsupportedImagePlazaPromptTags(input.prompt);
  if (!prompt) {
    throw new ImagePlazaUpstreamError('image_plaza_provider_content_rejected', false);
  }
  if (hadUnsupportedTags) {
    log.info(
      {
        event: 'image_plaza.provider.prompt_sanitized',
        providerModelId: input.providerModelId,
        mode: input.mode,
        promptLengthBefore: input.prompt.length,
        promptLengthAfter: prompt.length,
      },
      'Stripped unsupported LoRA-style tags from image plaza prompt'
    );
  }
  // Venice safe_mode 默认 true，成人内容会返回模糊图；广场按 uncensored 模型预期关闭。
  const body: Record<string, unknown> = {
    model: input.providerModelId,
    prompt,
    safe_mode: false,
  };
  if (isEdit && input.reference) {
    body.image = input.reference.bytes.toString('base64');
    body.aspect_ratio = input.aspectRatio;
    body.resolution = input.resolution === 'fixed' ? '1K' : input.resolution;
    body.output_format = 'webp';
  } else {
    body.variants = 1;
    body.format = 'webp';
    // generate 支持 enhance_prompt；默认跟随 auto_optimize（缺省 true）。
    body.enhance_prompt = input.autoOptimize !== false;
    if (input.sizingMode === 'pixels') {
      const dimensions = pixelDimensions(input.aspectRatio);
      body.width = dimensions.width;
      body.height = dimensions.height;
    } else {
      body.aspect_ratio = input.aspectRatio;
      if (input.sizingMode === 'resolution') {
        body.resolution = input.resolution === 'fixed' ? '1K' : input.resolution;
      }
    }
  }

  let response: Response;
  const startedAt = Date.now();
  try {
    response = await veniceFetch(
      `${config.imagePlaza.baseUrl.replace(/\/$/, '')}/image/${isEdit ? 'edit' : 'generate'}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.imagePlaza.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.imagePlaza.timeoutMs),
      }
    );
  } catch (err) {
    throw new ImagePlazaUpstreamError(
      'image_plaza_provider_outcome_unknown',
      true,
      err instanceof Error ? err.message : 'provider request failed'
    );
  }

  // 非 2xx 也要记录，便于区分“被审核拦截”和“上游故障”；只记录请求参数摘要，不含 prompt。
  log.info(
    {
      event: 'image_plaza.provider.response',
      providerModelId: input.providerModelId,
      mode: input.mode,
      status: response.status,
      durationMs: Date.now() - startedAt,
      request: {
        safeMode: body.safe_mode,
        enhancePrompt: body.enhance_prompt,
        format: body.format ?? body.output_format,
        aspectRatio: body.aspect_ratio,
        resolution: body.resolution,
        width: body.width,
        height: body.height,
        promptLength: prompt.length,
      },
      providerHeaders: collectProviderHeaders(response.headers),
    },
    'Image plaza provider responded'
  );

  if (!response.ok) {
    // Provider error bodies may echo prompts or images, so they must not be copied into logs/errors.
    throw new ImagePlazaUpstreamError(`image_plaza_provider_http_${response.status}`, false);
  }

  // 审核拦截时 Venice 仍可能 HTTP 200；在落库/结算前按响应头拒绝，避免黑图当成功并扣费。
  assertProviderContentAccepted(response.headers);

  if (isEdit) {
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_PROVIDER_IMAGE_BYTES) {
      throw new ImagePlazaUpstreamError('image_plaza_provider_image_too_large', true);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      throw new ImagePlazaUpstreamError(
        'image_plaza_provider_outcome_unknown',
        true,
        err instanceof Error ? err.message : 'provider response read failed'
      );
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROVIDER_IMAGE_BYTES) {
      throw new ImagePlazaUpstreamError('image_plaza_provider_image_invalid', true);
    }
    assertProviderImageLargeEnough(bytes.byteLength, {
      providerModelId: input.providerModelId,
      mode: input.mode,
    });
    log.info(
      {
        event: 'image_plaza.provider.image',
        providerModelId: input.providerModelId,
        mode: input.mode,
        imageBytes: bytes.byteLength,
      },
      'Image plaza provider image received'
    );
    return {
      bytes,
      mimeType: responseMimeType(response.headers.get('content-type')),
      providerRequestId: response.headers.get('x-request-id'),
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new ImagePlazaUpstreamError(
      'image_plaza_provider_outcome_unknown',
      true,
      err instanceof Error ? err.message : 'provider response parse failed'
    );
  }
  if (!payload || typeof payload !== 'object') {
    throw new ImagePlazaUpstreamError('image_plaza_provider_response_invalid', true);
  }
  const record = payload as Record<string, unknown>;
  const images = Array.isArray(record.images) ? record.images : [];
  const encoded = images[0];
  // 黑图的 webp 体积通常极小（纯色压缩后仅 1–2KB），imageBytes 可作为快速判断依据。
  const imageBytes = typeof encoded === 'string' ? Buffer.byteLength(encoded, 'base64') : null;
  log.info(
    {
      event: 'image_plaza.provider.image',
      providerModelId: input.providerModelId,
      mode: input.mode,
      imagesCount: images.length,
      imageBytes,
      contentPolicyViolationCount: record.content_policy_violation_count ?? null,
      payloadKeys: Object.keys(record),
    },
    'Image plaza provider image received'
  );
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new ImagePlazaUpstreamError('image_plaza_provider_image_missing', true);
  }
  const parsed = decodeProviderImage(encoded);
  assertProviderImageLargeEnough(parsed.bytes.byteLength, {
    providerModelId: input.providerModelId,
    mode: input.mode,
  });
  return {
    ...parsed,
    providerRequestId: typeof record.id === 'string' ? record.id : null,
  };
}

function providerHeaderIsTrue(headers: Headers, name: string): boolean {
  return headers.get(name)?.trim().toLowerCase() === 'true';
}

function assertProviderContentAccepted(headers: Headers): void {
  if (providerHeaderIsTrue(headers, 'x-venice-is-content-violation')) {
    throw new ImagePlazaUpstreamError('image_plaza_provider_content_rejected', false);
  }
}

function assertProviderImageLargeEnough(
  imageBytes: number,
  context: { providerModelId: string; mode: string }
): void {
  if (imageBytes >= MIN_ACCEPTABLE_PROVIDER_IMAGE_BYTES) return;
  log.info(
    {
      event: 'image_plaza.provider.image_rejected_too_small',
      providerModelId: context.providerModelId,
      mode: context.mode,
      imageBytes,
      minBytes: MIN_ACCEPTABLE_PROVIDER_IMAGE_BYTES,
    },
    'Image plaza provider image rejected as too small'
  );
  throw new ImagePlazaUpstreamError('image_plaza_provider_content_rejected', false);
}

function responseMimeType(contentType: string | null): PlazaMimeType {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp') {
    return normalized;
  }
  // Storage validation checks the magic bytes before persistence, so the fallback cannot smuggle
  // another media type but still handles providers that omit Content-Type.
  return 'image/webp';
}

function pixelDimensions(aspectRatio: string): { width: number; height: number } {
  const dimensions: Record<string, { width: number; height: number }> = {
    '1:1': { width: 1024, height: 1024 },
    '2:3': { width: 832, height: 1248 },
    '3:2': { width: 1248, height: 832 },
    '3:4': { width: 960, height: 1280 },
    '4:3': { width: 1280, height: 960 },
    '4:5': { width: 1024, height: 1280 },
    '9:16': { width: 720, height: 1280 },
    '16:9': { width: 1280, height: 720 },
    '21:9': { width: 1280, height: 552 },
  };
  const selected = dimensions[aspectRatio];
  if (!selected) throw new ImagePlazaUpstreamError('image_plaza_aspect_ratio_invalid', false);
  return selected;
}

function decodeProviderImage(value: string): { bytes: Buffer; mimeType: PlazaMimeType } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(value);
  const mimeType = (match?.[1] ?? 'image/webp') as PlazaMimeType;
  const encoded = match?.[2] ?? value;
  if (encoded.length > Math.ceil((MAX_PROVIDER_IMAGE_BYTES * 4) / 3) + 16) {
    throw new ImagePlazaUpstreamError('image_plaza_provider_image_too_large', false);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROVIDER_IMAGE_BYTES) {
    throw new ImagePlazaUpstreamError('image_plaza_provider_image_invalid', false);
  }
  return { bytes, mimeType };
}
