import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { IMAGE_PLAZA_PROMPT_MAX_CHARS, type ProviderImagePlazaModel } from '@miniapp/shared';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import XLSX from 'xlsx';
import { getDomainDb } from '../../lib/supabase.js';
import { deletePlazaImage, uploadSeedPlazaImage, type PlazaMimeType } from './storage.js';

const SOURCE_HEADERS = [
  'Venice 模型',
  '正向提示词',
  'Image URL',
  'Civitai Image ID（内部续爬去重）',
  '热度（Like + Heart）',
] as const;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_ATTEMPTS = 3;
const MAX_REDIRECTS = 3;
const CIVITAI_DOWNLOAD_HOSTS = new Set(['image.civitai.com', 'blobs-b2.civitai.com']);
let seedDownloadProxyAgent: ProxyAgent | undefined;

const SOURCE_MODEL_IDS = {
  'Seedream V5 Pro': 'seedream-v5-pro',
  'Krea 2 Turbo': 'krea-2-turbo',
  Chroma: 'chroma',
  'Lustify v8': 'lustify-v8',
  'Lustify SDXL': 'lustify-sdxl',
  'Anime (WAI)': 'anime-wai',
} as const;

export interface SeedApprovalManifest {
  approvedIds: ReadonlySet<string>;
}

export interface ImagePlazaSeedRow {
  rowNumber: number;
  sourceModelName: keyof typeof SOURCE_MODEL_IDS;
  modelId: (typeof SOURCE_MODEL_IDS)[keyof typeof SOURCE_MODEL_IDS];
  prompt: string;
  imageUrl: string;
  sourceImageId: string;
  sourceHeat: number;
  publishedAt: string;
}

export interface SeedWorkbookAudit {
  total: number;
  eligible: number;
  overPromptLimit: number;
  unapproved: number;
  invalid: number;
  duplicateSourceIds: number;
  duplicateImageUrls: number;
  approvedIdsNotFound: number;
  rows: ImagePlazaSeedRow[];
}

export interface SeedImportResult {
  status: 'imported' | 'already_imported';
  sourceImageId: string;
}

export async function closeSeedImportResources(): Promise<void> {
  const proxyAgent = seedDownloadProxyAgent;
  seedDownloadProxyAgent = undefined;
  if (proxyAgent) await proxyAgent.close();
}

export async function readSeedApprovalManifest(path: string): Promise<SeedApprovalManifest> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    raw.source !== 'civitai' ||
    !isBoundedText(raw.approval_batch_id, 120) ||
    !isBoundedText(raw.content_policy_version, 120)
  ) {
    throw new Error('image_plaza_seed_manifest_shape_invalid');
  }
  const entries = raw.approved_images;
  if (!Array.isArray(entries)) throw new Error('image_plaza_seed_manifest_entries_invalid');
  const approvedIds = new Set<string>();
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      entry.approved !== true ||
      entry.rights_confirmed !== true ||
      entry.content_reviewed !== true ||
      entry.metadata_verified !== true ||
      !isBoundedText(entry.reviewer, 120) ||
      !isIsoDateTime(entry.reviewed_at) ||
      !isBoundedText(entry.rights_evidence_ref, 500) ||
      !isBoundedText(entry.metadata_evidence_ref, 500)
    ) {
      throw new Error('image_plaza_seed_manifest_gate_incomplete');
    }
    const sourceImageId = normalizeSourceImageId(entry.civitai_image_id);
    if (!sourceImageId || approvedIds.has(sourceImageId)) {
      throw new Error('image_plaza_seed_manifest_id_invalid');
    }
    approvedIds.add(sourceImageId);
  }
  return { approvedIds };
}

export function auditSeedWorkbook(
  inputPath: string,
  approval?: SeedApprovalManifest
): SeedWorkbookAudit {
  const workbook = XLSX.readFile(inputPath, { cellDates: false, raw: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) throw new Error('image_plaza_seed_workbook_empty');

  const headerRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    range: 0,
    blankrows: false,
    defval: null,
  });
  const headers = headerRows[0];
  if (
    !Array.isArray(headers) ||
    SOURCE_HEADERS.some((header, index) => headers[index] !== header) ||
    headers.length !== SOURCE_HEADERS.length
  ) {
    throw new Error('image_plaza_seed_workbook_headers_invalid');
  }

  const sourceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const accepted: Omit<ImagePlazaSeedRow, 'publishedAt'>[] = [];
  let overPromptLimit = 0;
  let unapproved = 0;
  let invalid = 0;
  let duplicateSourceIds = 0;
  let duplicateImageUrls = 0;

  sourceRows.forEach((source, index) => {
    const sourceModelName = normalizeText(source['Venice 模型']);
    const prompt = normalizeText(source['正向提示词']);
    const imageUrl = normalizeCivitaiUrl(source['Image URL']);
    const sourceImageId = normalizeSourceImageId(source['Civitai Image ID（内部续爬去重）']);
    const sourceHeat = normalizeHeat(source['热度（Like + Heart）']);
    if (
      !isSourceModelName(sourceModelName) ||
      !prompt ||
      !imageUrl ||
      !sourceImageId ||
      sourceHeat === null
    ) {
      invalid += 1;
      return;
    }
    const modelId = SOURCE_MODEL_IDS[sourceModelName];
    if (seenIds.has(sourceImageId)) {
      duplicateSourceIds += 1;
      return;
    }
    seenIds.add(sourceImageId);
    if (seenUrls.has(imageUrl)) {
      duplicateImageUrls += 1;
      return;
    }
    seenUrls.add(imageUrl);
    if (prompt.length > IMAGE_PLAZA_PROMPT_MAX_CHARS) {
      overPromptLimit += 1;
      return;
    }
    if (approval && !approval.approvedIds.has(sourceImageId)) {
      unapproved += 1;
      return;
    }
    accepted.push({
      rowNumber: index + 2,
      sourceModelName,
      modelId,
      prompt,
      imageUrl,
      sourceImageId,
      sourceHeat,
    });
  });

  accepted.sort(
    (left, right) =>
      right.sourceHeat - left.sourceHeat ||
      compareDecimalIds(right.sourceImageId, left.sourceImageId)
  );
  const rows = accepted.map((row) => ({
    ...row,
    publishedAt: seedPublishedAt(row.sourceHeat, row.sourceImageId),
  }));
  const approvedIdsNotFound = approval
    ? [...approval.approvedIds].filter((sourceImageId) => !seenIds.has(sourceImageId)).length
    : 0;

  return {
    total: sourceRows.length,
    eligible: rows.length,
    overPromptLimit,
    unapproved,
    invalid,
    duplicateSourceIds,
    duplicateImageUrls,
    approvedIdsNotFound,
    rows,
  };
}

export async function importSeedRow(
  row: ImagePlazaSeedRow,
  model: ProviderImagePlazaModel
): Promise<SeedImportResult> {
  if (model.id !== row.modelId || !model.enabled) {
    throw new Error('image_plaza_seed_model_unavailable');
  }
  const existing = await findExistingSeed(row.sourceImageId);
  if (existing) {
    if (
      existing.sourceImageUrl !== row.imageUrl ||
      existing.modelId !== row.modelId ||
      existing.prompt !== row.prompt
    ) {
      throw new Error('image_plaza_seed_idempotency_conflict');
    }
    return { status: 'already_imported', sourceImageId: row.sourceImageId };
  }

  const downloaded = await downloadCivitaiImage(row.imageUrl);
  const stored = await uploadSeedPlazaImage({
    sourceImageId: row.sourceImageId,
    bytes: downloaded.bytes,
    declaredMimeType: downloaded.mimeType,
  });
  const aspectRatio = nearestAspectRatio(stored.width, stored.height, model.aspect_ratios);
  const resolution = model.resolutions[0]?.id;
  if (!resolution) {
    await deletePlazaImage(stored.storagePath).catch(() => undefined);
    throw new Error('image_plaza_seed_model_resolution_missing');
  }
  const snapshot = {
    prompt: row.prompt,
    model_id: row.modelId,
    aspect_ratio: aspectRatio,
    resolution,
    reasoning: false,
    auto_optimize: false,
    mode: 't2i',
    reference_artifact_id: null,
    style: 'None',
  } as const;

  try {
    const { data, error } = await getDomainDb('experience').rpc('import_image_plaza_seed_work', {
      p_source_image_id: row.sourceImageId,
      p_source_image_url: row.imageUrl,
      p_source_heat: row.sourceHeat,
      p_storage_path: stored.storagePath,
      p_mime_type: stored.mimeType,
      p_byte_size: stored.byteSize,
      p_width: stored.width,
      p_height: stored.height,
      p_title: `灵感作品 · ${model.name}`.slice(0, 80),
      p_model_id: row.modelId,
      p_model_name: model.name,
      p_snapshot: snapshot,
      p_published_at: row.publishedAt,
    });
    if (error || !isRecord(data)) {
      throw new Error(
        `image_plaza_seed_database_insert_failed:${error?.message ?? 'invalid result'}`
      );
    }
    return {
      status: data.already_imported === true ? 'already_imported' : 'imported',
      sourceImageId: row.sourceImageId,
    };
  } catch (error) {
    if (!(await isStoragePathReferenced(stored.storagePath))) {
      await deletePlazaImage(stored.storagePath).catch(() => undefined);
    }
    throw error;
  }
}

async function findExistingSeed(sourceImageId: string): Promise<{
  sourceImageUrl: string;
  modelId: string;
  prompt: string;
} | null> {
  const { data, error } = await getDomainDb('experience')
    .from('image_plaza_works')
    .select('source_image_url,model_id,snapshot')
    .eq('origin', 'civitai_seed')
    .eq('source_platform', 'civitai')
    .eq('source_image_id', sourceImageId)
    .maybeSingle();
  if (error) throw new Error(`image_plaza_seed_existing_read_failed:${error.message}`);
  if (!data) return null;
  const snapshot = isRecord(data.snapshot) ? data.snapshot : null;
  return {
    sourceImageUrl: String(data.source_image_url),
    modelId: String(data.model_id),
    prompt: typeof snapshot?.prompt === 'string' ? snapshot.prompt : '',
  };
}

async function isStoragePathReferenced(storagePath: string): Promise<boolean> {
  const { data, error } = await getDomainDb('experience')
    .from('image_plaza_artifacts')
    .select('id')
    .eq('storage_path', storagePath)
    .limit(1);
  if (error) return true;
  return (data?.length ?? 0) > 0;
}

async function downloadCivitaiImage(
  sourceUrl: string
): Promise<{ bytes: Buffer; mimeType?: PlazaMimeType }> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('image_plaza_seed_tls_verification_disabled');
  }
  const dispatcher = getSeedDownloadDispatcher();
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      let currentUrl = assertCivitaiImageUrl(sourceUrl);
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const response = await undiciFetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
          headers: { Accept: 'image/png,image/jpeg,image/webp' },
          ...(dispatcher ? { dispatcher } : {}),
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirect === MAX_REDIRECTS) {
            throw new Error('image_plaza_seed_redirect_invalid');
          }
          currentUrl = assertCivitaiDownloadUrl(new URL(location, currentUrl).toString());
          continue;
        }
        if (!response.ok) {
          throw new Error(`image_plaza_seed_download_status_${response.status}`);
        }
        const contentLength = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
          throw new Error('image_plaza_image_size_invalid');
        }
        const contentType = response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase();
        const mimeType = isPlazaMimeType(contentType) ? contentType : undefined;
        return { bytes: await readResponseWithLimit(response), mimeType };
      }
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('image_plaza_seed_download_failed');
}

async function readResponseWithLimit(
  response: Awaited<ReturnType<typeof undiciFetch>>
): Promise<Buffer> {
  if (!response.body) throw new Error('image_plaza_seed_download_body_missing');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error('image_plaza_image_size_invalid');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function getSeedDownloadDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim();
  if (!proxyUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error('image_plaza_seed_proxy_url_invalid');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hash) {
    throw new Error('image_plaza_seed_proxy_url_invalid');
  }
  seedDownloadProxyAgent ??= new ProxyAgent(parsed.toString());
  return seedDownloadProxyAgent;
}

function nearestAspectRatio(width: number, height: number, allowed: readonly string[]): string {
  const actual = width / height;
  const selected = allowed.reduce<{ id: string; distance: number } | null>((best, id) => {
    const [ratioWidth, ratioHeight] = id.split(':').map(Number);
    if (!ratioWidth || !ratioHeight) return best;
    const distance = Math.abs(Math.log(actual / (ratioWidth / ratioHeight)));
    return !best || distance < best.distance ? { id, distance } : best;
  }, null);
  if (!selected) throw new Error('image_plaza_seed_aspect_ratio_missing');
  return selected.id;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeSourceImageId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function normalizeHeat(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_147_483_647 ? parsed : null;
}

function normalizeCivitaiUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return assertCivitaiImageUrl(value).toString();
  } catch {
    return null;
  }
}

function assertCivitaiImageUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'image.civitai.com' ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('image_plaza_seed_url_rejected');
  }
  return parsed;
}

function assertCivitaiDownloadUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    !CIVITAI_DOWNLOAD_HOSTS.has(parsed.hostname) ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('image_plaza_seed_url_rejected');
  }
  return parsed;
}

function isSourceModelName(value: string | null): value is keyof typeof SOURCE_MODEL_IDS {
  return value !== null && Object.hasOwn(SOURCE_MODEL_IDS, value);
}

function isPlazaMimeType(value: string | undefined): value is PlazaMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

function compareDecimalIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

function seedPublishedAt(sourceHeat: number, sourceImageId: string): string {
  const base = Date.parse('2025-01-01T00:00:00.000Z');
  const tieBreakMilliseconds = Number(sourceImageId.slice(-3));
  return new Date(base + sourceHeat * 1_000 + tieBreakMilliseconds).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
