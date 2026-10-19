import { Buffer } from 'node:buffer';
import { config } from '../../platform/config.js';
import { veniceFetch } from '../../platform/venice-http.js';
import type { PlazaMimeType } from './storage.js';

const MAX_PROVIDER_IMAGE_BYTES = 20 * 1024 * 1024;

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
  // Venice safe_mode 默认 true，成人内容会返回模糊图；广场按 uncensored 模型预期关闭。
  const body: Record<string, unknown> = {
    model: input.providerModelId,
    prompt: input.prompt,
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

  if (!response.ok) {
    // Provider error bodies may echo prompts or images, so they must not be copied into logs/errors.
    throw new ImagePlazaUpstreamError(`image_plaza_provider_http_${response.status}`, false);
  }

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
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new ImagePlazaUpstreamError('image_plaza_provider_image_missing', true);
  }
  const parsed = decodeProviderImage(encoded);
  return {
    ...parsed,
    providerRequestId: typeof record.id === 'string' ? record.id : null,
  };
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
