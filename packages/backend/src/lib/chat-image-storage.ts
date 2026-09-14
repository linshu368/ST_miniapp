import { getSupabaseClient } from './supabase.js';
import { config } from '../platform/config.js';
import { ImageUpstreamError } from '../features/image/upstream.js';

const IMAGE_BUCKET = 'miniapp-chat-images';

const MIME_EXTENSIONS = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
} as const;

export interface StoredMessageImage {
  path: string;
  url: string;
  mimeType: keyof typeof MIME_EXTENSIONS;
  byteSize: number;
}

/** 下载 provider 临时图并转存到 Supabase 公开 bucket；调用方只向前端返回我们的 public URL。 */
export async function storeGeneratedMessageImage(input: {
  userId: string;
  messageId: string;
  attemptId: string;
  sourceUrl: string;
  maxBytes: number;
}): Promise<StoredMessageImage> {
  const downloaded = await downloadImage(input.sourceUrl, input.maxBytes);
  const extension = MIME_EXTENSIONS[downloaded.mimeType];
  const path = `${input.userId}/${input.messageId}/${input.attemptId}.${extension}`;
  const client = getSupabaseClient();

  const { error } = await client.storage.from(IMAGE_BUCKET).upload(path, downloaded.bytes, {
    contentType: downloaded.mimeType,
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) {
    throw new ImageUpstreamError('download', `image_storage_${error.name}`, error.message);
  }

  const { data } = client.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  return {
    path,
    url: data.publicUrl,
    mimeType: downloaded.mimeType,
    byteSize: downloaded.bytes.byteLength,
  };
}

async function downloadImage(
  url: string,
  maxBytes: number
): Promise<{ bytes: Buffer; mimeType: keyof typeof MIME_EXTENSIONS }> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(config.image.downloadTimeoutMs) });
  } catch (error) {
    throw new ImageUpstreamError(
      'download',
      'image_storage_download_failed',
      error instanceof Error ? error.message : '下载图片失败'
    );
  }

  if (!response.ok) {
    throw new ImageUpstreamError(
      'download',
      `image_storage_download_${response.status}`,
      `下载图片返回 HTTP ${response.status}`
    );
  }

  const mimeType = normalizeMimeType(response.headers.get('content-type'));
  if (!mimeType) {
    throw new ImageUpstreamError('download', 'image_storage_mime_type', '图片 MIME 类型不受支持');
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength <= 0 || bytes.byteLength > maxBytes) {
    throw new ImageUpstreamError('download', 'image_storage_size', '图片大小超出限制');
  }
  return { bytes, mimeType };
}

function normalizeMimeType(value: string | null): keyof typeof MIME_EXTENSIONS | null {
  const mime = value?.split(';')[0]?.trim().toLowerCase();
  return mime === 'image/webp' || mime === 'image/png' || mime === 'image/jpeg' ? mime : null;
}
