import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { CreatorCoverAsset, CreatorCoverRequest } from '@miniapp/shared';
import { getDomainDb, getSupabaseClient } from '../../lib/supabase.js';
import { downloadPlazaImage, validatePlazaImage } from '../image-plaza/storage.js';

const BUCKET = 'character-covers';
const SELECT = 'id,owner_user_id,storage_path,width,height';
const signed = new Map<string, { url: string; expires: number }>();

function bounded<T>(promise: PromiseLike<T>, milliseconds = 30_000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('creator_cover_timeout')), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function findAsset(id: string) {
  const { data, error } = await getDomainDb('app_core')
    .from('character_cover_assets')
    .select(SELECT)
    .eq('id', id)
    .abortSignal(AbortSignal.timeout(5000))
    .maybeSingle();
  if (error) throw new Error('creator_cover_read_failed', { cause: error });
  return data;
}

export async function assertCreatorCoverAssetOwned(assetId: string, userId: string): Promise<void> {
  const asset = await findAsset(assetId);
  if (!asset || asset.owner_user_id !== userId) throw new Error('creator_cover_not_found');
}

/** Call only after character access authorization. Storage is private even for draft covers. */
export async function resolveCreatorCoverUrl(assetId: string): Promise<string | null> {
  const cached = signed.get(assetId);
  if (cached && cached.expires > Date.now()) return cached.url;
  const asset = await findAsset(assetId);
  if (!asset) return null;
  const { data, error } = await bounded(
    getSupabaseClient().storage.from(BUCKET).createSignedUrl(String(asset.storage_path), 3600),
    10_000
  );
  if (error || !data?.signedUrl) throw new Error('creator_cover_sign_failed', { cause: error });
  if (signed.size >= 2000) {
    const key = signed.keys().next().value;
    if (key) signed.delete(key);
  }
  signed.set(assetId, { url: data.signedUrl, expires: Date.now() + 3300_000 });
  return data.signedUrl;
}

export async function getCreatorCoverAsset(
  assetId: string,
  userId: string
): Promise<CreatorCoverAsset> {
  const asset = await findAsset(assetId);
  if (!asset || asset.owner_user_id !== userId) throw new Error('creator_cover_not_found');
  const url = await resolveCreatorCoverUrl(assetId);
  if (!url) throw new Error('creator_cover_not_found');
  return {
    id: String(asset.id),
    image_url: url,
    width: Number(asset.width),
    height: Number(asset.height),
  };
}

async function artifactBytes(artifactId: string, userId: string): Promise<Buffer> {
  const db = getDomainDb('media_plaza');
  const { data: artifact, error } = await db
    .from('image_plaza_artifacts')
    .select('attempt_id,storage_path')
    .eq('id', artifactId)
    .abortSignal(AbortSignal.timeout(5000))
    .maybeSingle();
  if (error) throw new Error('creator_cover_source_read_failed', { cause: error });
  if (!artifact) throw new Error('creator_cover_not_found');
  const { data: attempt, error: attemptError } = await db
    .from('image_plaza_attempts')
    .select('id')
    .eq('id', String(artifact.attempt_id))
    .eq('user_id', userId)
    .eq('status', 'ready')
    .abortSignal(AbortSignal.timeout(5000))
    .maybeSingle();
  if (attemptError) throw new Error('creator_cover_source_read_failed', { cause: attemptError });
  if (!attempt) throw new Error('creator_cover_not_found');
  // Read only an authenticated, owned artifact path; never a client-supplied URL.
  return downloadPlazaImage(String(artifact.storage_path));
}

export async function createCreatorCoverAsset(
  input: CreatorCoverRequest,
  userId: string
): Promise<CreatorCoverAsset> {
  const existing = await findAsset(input.id);
  if (existing) return getCreatorCoverAsset(input.id, userId);
  const bytes =
    input.source === 'artifact'
      ? await artifactBytes(input.artifact_id, userId)
      : Buffer.from(input.image_base64.replace(/^data:image\/[a-z+]+;base64,/, ''), 'base64');
  const validated = validatePlazaImage(
    bytes,
    input.source === 'upload' ? input.mime_type : undefined
  );
  const ext = validated.mimeType === 'image/jpeg' ? 'jpg' : validated.mimeType.split('/')[1];
  // Independent immutable object for concurrent/retried uploads; cleanup never touches the winner.
  const storagePath = `${userId}/${input.id}/${randomUUID()}.${ext}`;
  const storage = getSupabaseClient().storage.from(BUCKET);
  const { error: uploadError } = await bounded(
    storage.upload(storagePath, bytes, {
      contentType: validated.mimeType,
      upsert: false,
      cacheControl: '31536000',
    })
  );
  if (uploadError) throw new Error('creator_cover_upload_failed', { cause: uploadError });
  const { error } = await getDomainDb('app_core')
    .from('character_cover_assets')
    .insert({
      id: input.id,
      owner_user_id: userId,
      storage_path: storagePath,
      mime_type: validated.mimeType,
      byte_size: bytes.byteLength,
      width: validated.width,
      height: validated.height,
    })
    .abortSignal(AbortSignal.timeout(10_000));
  if (error) {
    // A timeout may have committed. Re-read before compensating, retaining the file if ambiguous.
    const committed = await findAsset(input.id);
    if (!committed || committed.storage_path !== storagePath)
      await bounded(storage.remove([storagePath])).catch(() => undefined);
    if (!committed) throw new Error('creator_cover_save_failed', { cause: error });
  }
  return getCreatorCoverAsset(input.id, userId);
}
