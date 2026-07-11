import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getSupabaseClient } from './supabase.js';

const AVATAR_BUCKET = 'miniapp-user-avatars';
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 8_000;

interface ValidatedImage {
  buffer: Buffer;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
}

export function decodeUploadedAvatar(contentType: string, dataBase64: string): ValidatedImage {
  if (!dataBase64 || dataBase64.length > Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 8) {
    throw new Error('头像文件不能超过 2MB');
  }

  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length || buffer.length > MAX_AVATAR_BYTES) {
    throw new Error('头像文件不能为空且不能超过 2MB');
  }

  const image = validateImage(buffer);
  if (normalizeContentType(contentType) !== image.contentType) {
    throw new Error('头像文件类型与内容不一致');
  }
  return image;
}

export async function downloadRemoteAvatar(rawUrl: string): Promise<ValidatedImage> {
  let current = parseRemoteUrl(rawUrl);

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertPublicHost(current);
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      headers: { accept: 'image/jpeg,image/png,image/webp' },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new Error('头像链接重定向次数过多');
      current = parseRemoteUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok || !response.body) {
      throw new Error(`无法下载头像（HTTP ${response.status}）`);
    }

    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_AVATAR_BYTES) throw new Error('头像文件不能超过 2MB');

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AVATAR_BYTES) {
        await reader.cancel();
        throw new Error('头像文件不能超过 2MB');
      }
      chunks.push(value);
    }

    return validateImage(Buffer.concat(chunks));
  }

  throw new Error('无法下载头像');
}

export async function storeUserAvatar(userId: string, image: ValidatedImage): Promise<string> {
  const objectPath = `${userId}/avatar.${image.extension}`;
  const client = getSupabaseClient();
  const stalePaths = (['jpg', 'png', 'webp'] as const)
    .filter((extension) => extension !== image.extension)
    .map((extension) => `${userId}/avatar.${extension}`);
  await client.storage.from(AVATAR_BUCKET).remove(stalePaths);
  const { error } = await client.storage.from(AVATAR_BUCKET).upload(objectPath, image.buffer, {
    contentType: image.contentType,
    cacheControl: '3600',
    upsert: true,
  });
  if (error) throw new Error(`保存头像失败：${error.message}`);

  const { data } = client.storage.from(AVATAR_BUCKET).getPublicUrl(objectPath);
  return `${data.publicUrl}?v=${Date.now()}`;
}

export async function deleteStoredUserAvatar(userId: string): Promise<void> {
  const paths = (['jpg', 'png', 'webp'] as const).map(
    (extension) => `${userId}/avatar.${extension}`
  );
  const { error } = await getSupabaseClient().storage.from(AVATAR_BUCKET).remove(paths);
  if (error) throw new Error(`删除自定义头像失败：${error.message}`);
}

function validateImage(buffer: Buffer): ValidatedImage {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { buffer, contentType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { buffer, contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { buffer, contentType: 'image/webp', extension: 'webp' };
  }
  throw new Error('仅支持 PNG、JPEG 或 WebP 头像');
}

function normalizeContentType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function parseRemoteUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('头像链接格式不正确');
  }
  if (url.protocol !== 'https:') throw new Error('头像链接必须使用 HTTPS');
  if (url.username || url.password) throw new Error('头像链接不能包含账号凭据');
  return url;
}

async function assertPublicHost(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('头像链接不能指向本机或私有网络');
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd')
  ) {
    return true;
  }
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }

  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  if (isIP(ipv4) !== 4) return false;
  const octets = ipv4.split('.').map(Number);
  const a = octets[0]!;
  const b = octets[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}
