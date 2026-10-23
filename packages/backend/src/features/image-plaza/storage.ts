import { Buffer } from 'node:buffer';
import { getSupabaseClient } from '../../lib/supabase.js';

const BUCKET = 'image-plaza';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SEED_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * 私有资产的短 TTL：上传后的参考图、生成产物在用户分享之前只有本人能看到，
 * 一旦链接外泄就等于泄露未公开的作品，所以沿用原来的 15 分钟。
 */
const PRIVATE_IMAGE_URL_TTL_SECONDS = 15 * 60;

/**
 * 已发布作品图的 TTL。
 *
 * `image_plaza_works` 只会在分享成功后产生，所以这里签的都是已经在广场公开可见的
 * 图；给它 24 小时是为了让同一个签名 URL 在一整个使用周期内都保持稳定，从而让
 * CDN 与浏览器缓存真正命中（原因见下方 signedUrlCache）。
 */
const SHARED_WORK_IMAGE_URL_TTL_SECONDS = 24 * 60 * 60;

export type PlazaMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface StoredPlazaImage {
  storagePath: string;
  mimeType: PlazaMimeType;
  byteSize: number;
  width: number;
  height: number;
}

export function validatePlazaImage(
  bytes: Buffer,
  declaredMimeType?: string
): { mimeType: PlazaMimeType; width: number; height: number } {
  return validatePlazaImageWithLimit(bytes, declaredMimeType, MAX_IMAGE_BYTES);
}

function validatePlazaImageWithLimit(
  bytes: Buffer,
  declaredMimeType: string | undefined,
  maxBytes: number
): { mimeType: PlazaMimeType; width: number; height: number } {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error('image_plaza_image_size_invalid');
  }
  const detected = detectMimeType(bytes);
  if (!detected || (declaredMimeType && detected !== declaredMimeType)) {
    throw new Error('image_plaza_image_type_invalid');
  }
  const dimensions = readDimensions(bytes, detected);
  if (
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > 8192 ||
    dimensions.height > 8192
  ) {
    throw new Error('image_plaza_image_dimensions_invalid');
  }
  return { mimeType: detected, ...dimensions };
}

export async function uploadPlazaImage(input: {
  userId: string;
  namespace: 'references' | 'attempts';
  ownerId: string;
  position: number;
  bytes: Buffer;
  declaredMimeType?: string;
}): Promise<StoredPlazaImage> {
  const validated = validatePlazaImage(input.bytes, input.declaredMimeType);
  const extension = validated.mimeType === 'image/jpeg' ? 'jpg' : validated.mimeType.split('/')[1];
  const storagePath = `image-plaza/${input.userId}/${input.namespace}/${input.ownerId}/${input.position}.${extension}`;
  const { error } = await getSupabaseClient()
    .storage.from(BUCKET)
    .upload(storagePath, input.bytes, {
      contentType: validated.mimeType,
      cacheControl: '31536000',
      upsert: false,
    });
  if (error) throw new Error(`image_plaza_storage_upload_failed:${error.message}`);
  return {
    storagePath,
    mimeType: validated.mimeType,
    byteSize: input.bytes.byteLength,
    width: validated.width,
    height: validated.height,
  };
}

export async function uploadSeedPlazaImage(input: {
  sourceImageId: string;
  bytes: Buffer;
  declaredMimeType?: string;
}): Promise<StoredPlazaImage> {
  if (!/^\d+$/.test(input.sourceImageId)) {
    throw new Error('image_plaza_seed_source_id_invalid');
  }
  const validated = validatePlazaImageWithLimit(
    input.bytes,
    input.declaredMimeType,
    MAX_SEED_IMAGE_BYTES
  );
  const extension = validated.mimeType === 'image/jpeg' ? 'jpg' : validated.mimeType.split('/')[1];
  const storagePath = `image-plaza/imports/civitai/${input.sourceImageId}.${extension}`;
  const { error } = await getSupabaseClient()
    .storage.from(BUCKET)
    .upload(storagePath, input.bytes, {
      contentType: validated.mimeType,
      cacheControl: '31536000',
      upsert: false,
    });
  if (error) throw new Error(`image_plaza_storage_upload_failed:${error.message}`);
  return {
    storagePath,
    mimeType: validated.mimeType,
    byteSize: input.bytes.byteLength,
    width: validated.width,
    height: validated.height,
  };
}

/**
 * 签名结果缓存。
 *
 * 为什么必须缓存：私有桶的签名 URL 形如
 * `/storage/v1/object/sign/image-plaza/<path>?token=<JWT>`。Supabase Smart CDN 把
 * 完整 URL（含 token）当缓存键，每个新 token 都是一次独立的 cache miss。之前每次
 * 请求都重新签，等于每张图每次都回源 Storage，CDN 与浏览器缓存全部失效——这既是
 * 图片慢的原因，也是 Storage 出网流量的来源。
 *
 * 缓存后同一个 path 在 TTL 内返回逐字节相同的 URL，于是 CDN 与浏览器都能复用。
 *
 * 只缓存「已发布作品图」：这些图随 `image_plaza_works` 分享产生，本来就是公开内容；
 * 未分享的产物与参考图仍每次现签 15 分钟，避免提前泄露和内存里堆积一次性链接。
 *
 * 为什么进程内而不是 Redis：签名本身只是一次 HTTP 调用，缓存的目的是让 URL 稳定
 * 而不是省那一次调用。多副本各自缓存无妨——每个副本产出的 URL 都指向同一对象，
 * 只要它自身在 TTL 内稳定，CDN 就能命中。进程内存上限按条目数硬性截断，避免
 * 无界增长。
 */
const SIGNED_URL_CACHE_MAX_ENTRIES = 2000;
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

/** 提前 5 分钟失效，避免把即将过期的 URL 发给客户端。 */
const SIGNED_URL_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function signedUrlCacheKey(
  path: string,
  expiresInSeconds: number,
  transform?: { width: number; quality: number }
): string {
  // transform 会改变产物内容，必须进缓存键，否则缩略图和原图会互相覆盖。
  return transform
    ? `${path}|${expiresInSeconds}|${transform.width}x${transform.quality}`
    : `${path}|${expiresInSeconds}|`;
}

/** 缓存表按插入顺序淘汰最旧条目：Map 迭代顺序即插入顺序。 */
function readSignedUrlCache(key: string): string | null {
  const hit = signedUrlCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    signedUrlCache.delete(key);
    return null;
  }
  return hit.url;
}

function writeSignedUrlCache(key: string, url: string, expiresInSeconds: number): void {
  const expiresAt = Date.now() + expiresInSeconds * 1000 - SIGNED_URL_REFRESH_MARGIN_MS;
  // TTL 短于刷新余量时不缓存，否则写入即为过期，反而多一次无用的删写。
  if (expiresAt <= Date.now()) return;
  signedUrlCache.delete(key);
  signedUrlCache.set(key, { url, expiresAt });
  while (signedUrlCache.size > SIGNED_URL_CACHE_MAX_ENTRIES) {
    const oldest = signedUrlCache.keys().next();
    if (oldest.done) break;
    signedUrlCache.delete(oldest.value);
  }
}

export async function signPlazaImagePath(
  path: string,
  expiresInSeconds = PRIVATE_IMAGE_URL_TTL_SECONDS,
  transform?: { width: number; quality: number }
): Promise<string> {
  assertPlazaPath(path);
  const cacheKey = signedUrlCacheKey(path, expiresInSeconds, transform);
  const cached = readSignedUrlCache(cacheKey);
  if (cached) return cached;

  // 签名失败会让整页图片 500，所以给显式超时。Storage SDK 的 createSignedUrl 直接
  // 返回 Promise、不支持 abortSignal，只能用赛跑的方式兜住——签名是只读操作，
  // 超时后放弃等待不会留下半成品。
  const { data, error } = await withTimeout(
    getSupabaseClient()
      .storage.from(BUCKET)
      .createSignedUrl(path, expiresInSeconds, {
        ...(transform ? { transform } : {}),
      }),
    10_000,
    'image_plaza_storage_sign_timeout'
  );
  if (error || !data?.signedUrl) throw new Error('image_plaza_storage_sign_failed');
  writeSignedUrlCache(cacheKey, data.signedUrl, expiresInSeconds);
  return data.signedUrl;
}

/** 超时即拒绝；原 Promise 的后续结果被 race 吞掉，不会产生未处理拒绝。 */
function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 已发布作品图的签名入口。与 `signPlazaImagePath` 的唯一差别是 TTL 取 24 小时，
 * 让 URL 在用户一整个浏览周期里保持不变，从而吃到 CDN 与浏览器缓存。
 */
export async function signSharedWorkImagePath(
  path: string,
  transform?: { width: number; quality: number }
): Promise<string> {
  return signPlazaImagePath(path, SHARED_WORK_IMAGE_URL_TTL_SECONDS, transform);
}

export async function downloadPlazaImage(path: string): Promise<Buffer> {
  const url = await signPlazaImagePath(path, 60);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`image_plaza_storage_download_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  validatePlazaImage(bytes);
  return bytes;
}

export async function deletePlazaImage(path: string): Promise<void> {
  assertPlazaPath(path);
  const { error } = await getSupabaseClient().storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`image_plaza_storage_delete_failed:${error.message}`);
}

function assertPlazaPath(path: string): void {
  if (
    !/^image-plaza\/[0-9a-f-]+\/(?:references|attempts)\/[0-9a-f-]+\/\d+\.(?:png|jpg|webp)$/i.test(
      path
    ) &&
    !/^image-plaza\/imports\/civitai\/\d+\.(?:png|jpg|webp)$/i.test(path)
  ) {
    throw new Error('image_plaza_storage_path_rejected');
  }
}

function detectMimeType(bytes: Buffer): PlazaMimeType | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

function readDimensions(
  bytes: Buffer,
  mimeType: PlazaMimeType
): { width: number; height: number } | null {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
  }
  if (mimeType === 'image/webp' && bytes.length >= 30) {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (kind === 'VP8 ' && bytes.length >= 30) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      return {
        width: 1 + (((bytes[22] ?? 0) & 0x3f) << 8) + (bytes[21] ?? 0),
        height:
          1 +
          (((bytes[24] ?? 0) & 0x0f) << 10) +
          ((bytes[23] ?? 0) << 2) +
          (((bytes[22] ?? 0) & 0xc0) >> 6),
      };
    }
  }
  return null;
}
