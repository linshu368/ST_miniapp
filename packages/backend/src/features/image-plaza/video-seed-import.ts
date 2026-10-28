import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import XLSX from 'xlsx';
import type { VideoPlazaModelCatalog } from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import { deletePlazaVideoAssets, uploadPlazaVideoAsset } from './storage.js';
import { prepareVideo } from './video-media.js';

const SOURCE_HEADERS = [
  'Venice 模型',
  '正向提示词',
  'Video URL',
  'Civitai Video ID（内部续爬去重）',
  '热度（Like + Heart）',
  '可能的垫图列表',
] as const;
const TRANSLATION_HEADERS = ['type', 'id', 'model', 'heat', 'prompt_en', 'prompt_zh'] as const;
const MODEL_IDS: Record<string, string> = {
  'Wan 3.0 Pro': 'wan-3-0-pro',
  'Wan 3.0 Reference': 'wan-3-0-reference',
  'MiniMax H3 Max': 'minimax-h3-max',
  'MiniMax H3 Max R2V': 'minimax-h3-max-r2v',
  'Seedance 1.5 Pro': 'seedance-1-5-pro',
  'Seedance 2.0 R2V Enhanced': 'seedance-2-0-r2v',
};
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CIVITAI_VIDEO_HOSTS = new Set(['image.civitai.com', 'blobs-b2.civitai.com']);
let videoSeedProxyAgent: ProxyAgent | undefined;

export async function closeVideoSeedImportResources(): Promise<void> {
  const proxyAgent = videoSeedProxyAgent;
  videoSeedProxyAgent = undefined;
  if (proxyAgent) await proxyAgent.destroy();
}

export interface VideoSeedSourceRow {
  rowNumber: number;
  sourceModelName: string;
  modelId: string;
  prompt: string;
  promptZh: string;
  videoUrl: string;
  sourceVideoId: string;
  sourceHeat: number;
  publishedAt: string;
}

export interface VideoSeedAudit {
  total: number;
  eligible: number;
  excluded: number;
  needsRepair: number;
  invalid: number;
  duplicateIds: number;
  translationOrphans: number;
  rows: VideoSeedSourceRow[];
}

export interface VideoSeedSelectionGroup {
  modelId: string;
  modelName: string;
  candidateCount: number;
  quota: number;
  cutoffHeat: number;
  cutoffTieCount: number;
}

export interface VideoSeedSelection {
  rows: VideoSeedSourceRow[];
  groups: VideoSeedSelectionGroup[];
}

export function readVideoSourceRows(
  inputPath: string
): Array<Omit<VideoSeedSourceRow, 'promptZh' | 'publishedAt'>> {
  const records = readSheet(inputPath, SOURCE_HEADERS);
  return records.map((record, index) => {
    const model = text(record['Venice 模型']);
    const prompt = text(record['正向提示词']);
    const videoUrl = httpsUrl(record['Video URL']);
    const sourceVideoId = text(record['Civitai Video ID（内部续爬去重）']);
    const sourceHeat = Number(record['热度（Like + Heart）']);
    const modelId = MODEL_IDS[model];
    if (
      !modelId ||
      !prompt ||
      !videoUrl ||
      !sourceVideoId ||
      !Number.isInteger(sourceHeat) ||
      sourceHeat < 0
    )
      throw new Error(`video_seed_row_invalid:${index + 2}`);
    return {
      rowNumber: index + 2,
      sourceModelName: model,
      modelId,
      prompt,
      videoUrl,
      sourceVideoId,
      sourceHeat,
    };
  });
}

export function auditVideoSeedWorkbooks(
  inputPath: string,
  translationPath: string
): VideoSeedAudit {
  let sourceRows: ReturnType<typeof readVideoSourceRows> = [];
  let invalid = 0;
  try {
    sourceRows = readVideoSourceRows(inputPath);
  } catch (err) {
    throw err;
  }
  const translations = readSheet(translationPath, TRANSLATION_HEADERS);
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of translations) {
    const id = text(row.id);
    if (id) byId.set(id, row);
  }
  const seen = new Set<string>();
  const matched = new Set<string>();
  const rows: VideoSeedSourceRow[] = [];
  let excluded = 0;
  let needsRepair = 0;
  let duplicateIds = 0;
  for (const source of sourceRows) {
    if (seen.has(source.sourceVideoId)) {
      duplicateIds += 1;
      continue;
    }
    seen.add(source.sourceVideoId);
    const key = sourceKey(source.videoUrl);
    const translation = byId.get(key);
    if (!translation) {
      excluded += 1;
      continue;
    }
    matched.add(key);
    const promptZh = text(translation.prompt_zh);
    if (
      text(translation.type) !== 'video' ||
      text(translation.model) !== source.sourceModelName ||
      Number(translation.heat) !== source.sourceHeat ||
      compact(text(translation.prompt_en)) !== compact(source.prompt) ||
      !promptZh
    ) {
      needsRepair += 1;
      continue;
    }
    rows.push({
      ...source,
      promptZh,
      publishedAt: new Date(Date.UTC(2026, 0, 1) + rows.length * 1000).toISOString(),
    });
  }
  const translationOrphans = [...byId.keys()].filter((id) => !matched.has(id)).length;
  return {
    total: sourceRows.length,
    eligible: rows.length,
    excluded,
    needsRepair,
    invalid,
    duplicateIds,
    translationOrphans,
    rows,
  };
}

/**
 * Max-min fair allocation keeps small model catalogs represented without allowing large catalogs
 * to consume their places. Rows are interleaved by rank so early canary batches also cover models.
 */
export function selectBalancedTopVideoSeedRows(
  rows: VideoSeedSourceRow[],
  targetCount: number
): VideoSeedSelection {
  if (!Number.isSafeInteger(targetCount) || targetCount < 1)
    throw new Error('video_seed_selection_target_invalid');
  if (rows.length < targetCount) throw new Error('video_seed_selection_insufficient_candidates');

  const byModel = new Map<string, VideoSeedSourceRow[]>();
  for (const row of rows) {
    const group = byModel.get(row.modelId) ?? [];
    group.push(row);
    byModel.set(row.modelId, group);
  }
  const models = [...byModel.entries()]
    .map(([modelId, candidates]) => ({
      modelId,
      modelName: candidates[0]?.sourceModelName ?? modelId,
      candidates: [...candidates].sort(compareVideoSeedRank),
      quota: 0,
    }))
    .sort((left, right) => compareStableText(left.modelId, right.modelId));
  if (!models.length) throw new Error('video_seed_selection_insufficient_candidates');

  let remaining = targetCount;
  let active = [...models];
  while (remaining > 0) {
    if (!active.length) throw new Error('video_seed_selection_insufficient_candidates');
    const evenShare = Math.floor(remaining / active.length);
    const exhausted = active.filter((model) => model.candidates.length - model.quota <= evenShare);
    if (exhausted.length) {
      const exhaustedIds = new Set(exhausted.map((model) => model.modelId));
      for (const model of exhausted) {
        const available = model.candidates.length - model.quota;
        model.quota += available;
        remaining -= available;
      }
      active = active.filter((model) => !exhaustedIds.has(model.modelId));
      continue;
    }
    const remainder = remaining % active.length;
    for (let index = 0; index < active.length; index += 1) {
      active[index]!.quota += evenShare + (index < remainder ? 1 : 0);
    }
    remaining = 0;
  }

  const selected: VideoSeedSourceRow[] = [];
  const maxQuota = Math.max(...models.map((model) => model.quota));
  for (let rank = 0; rank < maxQuota; rank += 1) {
    for (const model of models) {
      const row = rank < model.quota ? model.candidates[rank] : undefined;
      if (row) selected.push(row);
    }
  }
  if (selected.length !== targetCount) throw new Error('video_seed_selection_count_mismatch');

  return {
    rows: selected,
    groups: models.map((model) => {
      const cutoffHeat = model.candidates[model.quota - 1]?.sourceHeat;
      if (cutoffHeat === undefined) throw new Error('video_seed_selection_count_mismatch');
      return {
        modelId: model.modelId,
        modelName: model.modelName,
        candidateCount: model.candidates.length,
        quota: model.quota,
        cutoffHeat,
        cutoffTieCount: model.candidates.filter((row) => row.sourceHeat === cutoffHeat).length,
      };
    }),
  };
}

function compareVideoSeedRank(left: VideoSeedSourceRow, right: VideoSeedSourceRow): number {
  return (
    right.sourceHeat - left.sourceHeat || compareStableText(left.sourceVideoId, right.sourceVideoId)
  );
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function workbookSha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export async function headVideoSize(url: string): Promise<number> {
  assertSourceUrl(url);
  assertTlsVerificationEnabled();
  const dispatcher = getVideoSeedDispatcher();
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchCivitaiVideo(url, 'HEAD', 30_000, dispatcher);
      if (!response.ok) throw new Error(`head_http_${response.status}`);
      const size = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(size) || size < 1) throw new Error('head_content_length_missing');
      return size;
    } catch (err) {
      last = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw last instanceof Error ? last : new Error('video_seed_head_failed');
}

async function downloadSeedVideo(url: string): Promise<Buffer> {
  assertTlsVerificationEnabled();
  const dispatcher = getVideoSeedDispatcher();
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetchCivitaiVideo(url, 'GET', 120_000, dispatcher);
    } catch (err) {
      last = err;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      break;
    }
    if (!response.ok) {
      const error = new Error(`video_seed_download_${response.status}`);
      if (response.status !== 408 && response.status !== 429 && response.status < 500) throw error;
      last = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      break;
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_VIDEO_BYTES) throw new Error('video_seed_asset_too_large');
    try {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_VIDEO_BYTES)
        throw new Error('video_seed_asset_too_large');
      return bytes;
    } catch (err) {
      if (err instanceof Error && err.message === 'video_seed_asset_too_large') throw err;
      last = err;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
  throw last instanceof Error ? last : new Error('video_seed_download_failed');
}

export async function importVideoSeedRow(
  row: VideoSeedSourceRow,
  catalog: VideoPlazaModelCatalog
): Promise<'imported' | 'already_imported'> {
  assertSourceUrl(row.videoUrl);
  const db = getDomainDb('media_plaza');
  const { data: existing, error: existingError } = await db
    .from('video_artifacts')
    .select('id,source_video_url')
    .eq('origin', 'civitai_seed')
    .eq('source_video_id', row.sourceVideoId)
    .maybeSingle();
  if (existingError) throw new Error(`video_seed_existing_read_failed:${existingError.message}`);
  if (existing) {
    if (existing.source_video_url !== row.videoUrl)
      throw new Error('video_seed_idempotency_conflict');
    return 'already_imported';
  }
  const model = catalog.models.find(
    (item) => item.id === row.modelId || item.seed_aliases.includes(row.sourceModelName)
  );
  if (!model) throw new Error('video_seed_model_unavailable');
  const bytes = await downloadSeedVideo(row.videoUrl);
  const prepared = await prepareVideo(bytes);
  const safeId = row.sourceVideoId.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120);
  const videoPath = `media-plaza-video/imports/civitai/${safeId}/video.mp4`;
  const posterPath = `media-plaza-video/imports/civitai/${safeId}/poster.jpg`;
  try {
    await uploadPlazaVideoAsset({
      path: videoPath,
      bytes: prepared.video,
      contentType: 'video/mp4',
    });
    await uploadPlazaVideoAsset({
      path: posterPath,
      bytes: prepared.poster,
      contentType: 'image/jpeg',
    });
    const resolution = model.default_resolution;
    const aspectRatio = model.default_aspect_ratio;
    const duration = model.durations.reduce(
      (best, value) =>
        Math.abs(value * 1000 - prepared.durationMs) < Math.abs(best * 1000 - prepared.durationMs)
          ? value
          : best,
      model.default_duration
    );
    const snapshot = {
      prompt: row.prompt,
      prompt_zh: row.promptZh,
      prompt_zh_source: 'translation_pack',
      model_id: model.id,
      input_mode: model.image_input === 'required_reference' ? 'r2v' : 't2v',
      duration_s: duration,
      resolution,
      aspect_ratio: aspectRatio,
      audio: model.default_audio,
      reference_artifact_id: null,
      source_heat: row.sourceHeat,
    };
    const { error } = await db.rpc('import_video_seed_work', {
      p_source_video_id: row.sourceVideoId,
      p_source_video_url: row.videoUrl,
      p_source_heat: row.sourceHeat,
      p_storage_path: videoPath,
      p_byte_size: prepared.video.byteLength,
      p_width: prepared.width,
      p_height: prepared.height,
      p_duration_ms: prepared.durationMs,
      p_poster_path: posterPath,
      p_poster_width: prepared.width,
      p_poster_height: prepared.height,
      p_title: row.promptZh.slice(0, 80),
      p_description: row.promptZh.slice(0, 500),
      p_model_id: model.id,
      p_model_name: model.name,
      p_snapshot: snapshot,
      p_published_at: row.publishedAt,
    });
    if (error) throw new Error(`video_seed_import_rpc_failed:${error.message}`);
    return 'imported';
  } catch (err) {
    await deletePlazaVideoAssets([videoPath, posterPath]).catch(() => undefined);
    throw err;
  }
}

function readSheet(path: string, headers: readonly string[]): Record<string, unknown>[] {
  const workbook = XLSX.readFile(path, { raw: true, cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
  if (!sheet) throw new Error('video_seed_workbook_empty');
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: null,
  });
  if (
    !Array.isArray(matrix[0]) ||
    headers.some((header, index) => matrix[0]?.[index] !== header) ||
    matrix[0].length !== headers.length
  )
    throw new Error('video_seed_workbook_headers_invalid');
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: null });
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}
function compact(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
function httpsUrl(value: unknown): string {
  const raw = text(value);
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}
function sourceKey(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.replace(/^\/+/, '');
}
function assertSourceUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'image.civitai.com')
    throw new Error('video_seed_source_url_rejected');
}

async function fetchCivitaiVideo(
  sourceUrl: string,
  method: 'HEAD' | 'GET',
  timeoutMs: number,
  dispatcher: Dispatcher | undefined
): Promise<Response> {
  let currentUrl = assertCivitaiVideoUrl(sourceUrl, true);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = (await undiciFetch(currentUrl, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    })) as unknown as Response;
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirect === MAX_REDIRECTS) {
      throw new Error('video_seed_redirect_invalid');
    }
    currentUrl = assertCivitaiVideoUrl(new URL(location, currentUrl).toString(), false);
  }
  throw new Error('video_seed_redirect_invalid');
}

function assertCivitaiVideoUrl(value: string, sourceOnly: boolean): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    (sourceOnly ? url.hostname !== 'image.civitai.com' : !CIVITAI_VIDEO_HOSTS.has(url.hostname)) ||
    url.username ||
    url.password
  ) {
    throw new Error('video_seed_source_url_rejected');
  }
  return url.toString();
}

function assertTlsVerificationEnabled(): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('video_seed_tls_verification_disabled');
  }
}

function getVideoSeedDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim();
  if (!proxyUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error('video_seed_proxy_url_invalid');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hash) {
    throw new Error('video_seed_proxy_url_invalid');
  }
  videoSeedProxyAgent ??= new ProxyAgent(parsed.toString());
  return videoSeedProxyAgent;
}
