import { getSupabaseClient } from './supabase.js';
import { config } from '../platform/config.js';
import { ImageUpstreamError } from '../features/generation/image-upstream.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const IMAGE_BUCKET = 'miniapp-chat-images';

const MIME_EXTENSIONS = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
} as const;

export type StoredImageMimeType = keyof typeof MIME_EXTENSIONS;

export interface StoredMessageImage {
  path: string;
  url: string;
  mimeType: StoredImageMimeType;
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
  return uploadGeneratedMessageImage({
    userId: input.userId,
    messageId: input.messageId,
    attemptId: input.attemptId,
    bytes: downloaded.bytes,
    mimeType: downloaded.mimeType,
    maxBytes: input.maxBytes,
  });
}

export async function storeGeneratedMessageImageBytes(input: {
  userId: string;
  messageId: string;
  attemptId: string;
  bytes: Buffer;
  mimeType: StoredImageMimeType;
  maxBytes: number;
}): Promise<StoredMessageImage> {
  return uploadGeneratedMessageImage(input);
}

async function uploadGeneratedMessageImage(input: {
  userId: string;
  messageId: string;
  attemptId: string;
  bytes: Buffer;
  mimeType: StoredImageMimeType;
  maxBytes: number;
}): Promise<StoredMessageImage> {
  if (input.bytes.byteLength <= 0 || input.bytes.byteLength > input.maxBytes)
    throw imageSizeError();
  const extension = MIME_EXTENSIONS[input.mimeType];
  const path = `${input.userId}/${input.messageId}/${input.attemptId}.${extension}`;
  const client = getSupabaseClient();

  const { error } = await client.storage.from(IMAGE_BUCKET).upload(path, input.bytes, {
    contentType: input.mimeType,
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
    mimeType: input.mimeType,
    byteSize: input.bytes.byteLength,
  };
}

/** 仅删除本功能稳定路径下的对象，用于结算明确失败后的补偿。 */
export async function deleteGeneratedMessageImage(path: string): Promise<void> {
  if (!/^[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+\.(?:webp|png|jpg)$/i.test(path)) {
    throw new Error('拒绝删除不属于聊天图片命名空间的对象');
  }
  const { error } = await getSupabaseClient().storage.from(IMAGE_BUCKET).remove([path]);
  if (error) throw new Error(`删除聊天图片对象失败：${error.message}`);
}

async function downloadImage(
  url: string,
  maxBytes: number
): Promise<{ bytes: Buffer; mimeType: StoredImageMimeType }> {
  const response = await fetchValidatedImage(url);

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

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw imageSizeError();
  if (!response.body)
    throw new ImageUpstreamError('download', 'image_storage_empty', '图片响应为空');
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > maxBytes) throw imageSizeError();
    chunks.push(bytes);
  }
  if (byteLength <= 0) throw imageSizeError();
  const bytes = Buffer.concat(chunks, byteLength);
  return { bytes, mimeType };
}

/** 每一跳都拒绝非 HTTPS、凭据 URL 和私网地址，限制 provider URL 带来的 SSRF 面。 */
async function fetchValidatedImage(initialUrl: string): Promise<Response> {
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertPublicHttpsUrl(current);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(config.image.downloadTimeoutMs),
      });
    } catch (error) {
      throw new ImageUpstreamError(
        'download',
        'image_storage_download_failed',
        error instanceof Error ? error.message : '下载图片失败'
      );
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirects === 3) {
      throw new ImageUpstreamError('download', 'image_storage_redirect', '图片重定向无效或过多');
    }
    current = new URL(location, current);
  }
  throw new ImageUpstreamError('download', 'image_storage_redirect', '图片重定向过多');
}

async function assertPublicHttpsUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ImageUpstreamError('download', 'image_storage_url_rejected', '图片 URL 不受信任');
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ImageUpstreamError('download', 'image_storage_url_rejected', '图片 URL 指向受限网络');
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.includes(':')) {
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.')
    );
  }
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [a, b] = octets;
  if (a === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function imageSizeError(): ImageUpstreamError {
  return new ImageUpstreamError('download', 'image_storage_size', '图片大小超出限制');
}

function normalizeMimeType(value: string | null): StoredImageMimeType | null {
  const mime = value?.split(';')[0]?.trim().toLowerCase();
  return mime === 'image/webp' || mime === 'image/png' || mime === 'image/jpeg' ? mime : null;
}
