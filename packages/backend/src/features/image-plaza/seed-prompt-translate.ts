import { IMAGE_PLAZA_PROMPT_MAX_CHARS, ImagePlazaSnapshotSchema } from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import { config } from '../../platform/config.js';
import { translateImagePlazaPromptToZh } from '../generation/image-plaza-prompt-translate.js';

export interface SeedPromptTranslateRow {
  id: string;
  prompt: string;
  promptZh: string | null;
}

export type SeedPromptTranslateStatus =
  | 'translated'
  | 'skipped_existing'
  | 'failed_over_limit'
  | 'failed';

export async function listCivitaiSeedWorksForPromptTranslate(input: {
  offset: number;
  limit?: number;
}): Promise<SeedPromptTranslateRow[]> {
  const end =
    input.limit === undefined ? input.offset + 9_999 : input.offset + Math.max(input.limit, 1) - 1;
  const { data, error } = await getDomainDb('experience')
    .from('image_plaza_works')
    .select('id,snapshot')
    .eq('origin', 'civitai_seed')
    .eq('source_platform', 'civitai')
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .range(input.offset, end);
  if (error) throw new Error(`image_plaza_seed_prompt_list_failed:${error.message}`);

  return (data ?? []).flatMap((row) => {
    const parsed = ImagePlazaSnapshotSchema.safeParse(row.snapshot);
    if (!parsed.success || typeof row.id !== 'string') return [];
    const promptZh =
      typeof parsed.data.prompt_zh === 'string' && parsed.data.prompt_zh.trim().length > 0
        ? parsed.data.prompt_zh.trim()
        : null;
    return [
      {
        id: row.id,
        prompt: parsed.data.prompt,
        promptZh,
      },
    ];
  });
}

export async function translateAndStoreSeedPrompt(input: {
  workId: string;
  force: boolean;
}): Promise<SeedPromptTranslateStatus> {
  const { data, error } = await getDomainDb('experience')
    .from('image_plaza_works')
    .select('id,snapshot')
    .eq('id', input.workId)
    .eq('origin', 'civitai_seed')
    .eq('source_platform', 'civitai')
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new Error(`image_plaza_seed_prompt_read_failed:${error.message}`);
  if (!data) throw new Error('image_plaza_seed_prompt_work_missing');

  const parsed = ImagePlazaSnapshotSchema.safeParse(data.snapshot);
  if (!parsed.success) throw new Error('image_plaza_seed_prompt_snapshot_invalid');

  const existing =
    typeof parsed.data.prompt_zh === 'string' && parsed.data.prompt_zh.trim().length > 0
      ? parsed.data.prompt_zh.trim()
      : null;
  if (existing && !input.force) return 'skipped_existing';

  const translated = await translateImagePlazaPromptToZh({
    prompt: parsed.data.prompt,
    apiKey: config.imagePlaza.apiKey,
    baseUrl: config.imagePlaza.baseUrl,
    model: config.imagePlaza.taggingModel,
  });
  const promptZh = translated.trim();
  if (!promptZh || promptZh.length > IMAGE_PLAZA_PROMPT_MAX_CHARS) {
    return 'failed_over_limit';
  }

  const nextSnapshot = { ...parsed.data, prompt_zh: promptZh };
  const { error: updateError } = await getDomainDb('experience')
    .from('image_plaza_works')
    .update({ snapshot: nextSnapshot })
    .eq('id', input.workId)
    .eq('origin', 'civitai_seed');
  if (updateError) throw new Error(`image_plaza_seed_prompt_update_failed:${updateError.message}`);
  return 'translated';
}
