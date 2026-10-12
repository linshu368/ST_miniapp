import { Buffer } from 'node:buffer';
import { config } from '../../platform/config.js';
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
  mode: 't2i' | 'i2i' | 'edit';
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
  const body: Record<string, unknown> = {
    model: input.providerModelId,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution === 'fixed' ? '1K' : input.resolution,
    variants: 1,
    format: 'webp',
  };
  if (isEdit && input.reference) {
    body.images = [
      `data:${input.reference.mimeType};base64,${input.reference.bytes.toString('base64')}`,
    ];
  }

  let response: Response;
  try {
    response = await fetch(
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

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== 'object') {
    throw new ImagePlazaUpstreamError('image_plaza_provider_response_invalid', false);
  }
  const record = payload as Record<string, unknown>;
  const images = Array.isArray(record.images) ? record.images : [];
  const encoded = images[0];
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new ImagePlazaUpstreamError('image_plaza_provider_image_missing', false);
  }
  const parsed = decodeProviderImage(encoded);
  return {
    ...parsed,
    providerRequestId: typeof record.id === 'string' ? record.id : null,
  };
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
