import { Buffer } from 'node:buffer';
import { getSupabaseClient } from '../../lib/supabase.js';

const BUCKET = 'image-plaza';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SEED_IMAGE_BYTES = 50 * 1024 * 1024;

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

export async function signPlazaImagePath(path: string, expiresInSeconds = 900): Promise<string> {
  assertPlazaPath(path);
  const { data, error } = await getSupabaseClient()
    .storage.from(BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) throw new Error('image_plaza_storage_sign_failed');
  return data.signedUrl;
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
