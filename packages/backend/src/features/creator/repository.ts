import {
  CharacterDraftSchema,
  composeCharacterSystemPrompt,
  emptyCharacterDraft,
  type CharacterDraft,
  type CreatorCharacter,
  type CreatorCharacterSummary,
  type CreatorReviewStatus,
  type CreatorVisibility,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import { resolveCreatorCoverUrl } from './covers.js';
import { resolveCreatorPresets } from './preset-catalog.js';

const TIMEOUT_MS = 8_000;
interface CreationRow {
  character_id: string;
  owner_user_id: string;
  draft: unknown;
  cover_asset_id: string | null;
  state: 'draft' | 'ready';
  visibility: CreatorVisibility;
  review_status: CreatorReviewStatus;
  review_message: string | null;
  revision: number;
  submitted_revision: number | null;
  published_revision: number | null;
  approved_revision: number | null;
  created_at: string;
  updated_at: string;
}
interface SummaryRow extends Omit<CreationRow, 'draft'> {
  name: string;
  description: string;
  tags: string[];
}
const SUMMARY_COLUMNS =
  'character_id,owner_user_id,name:draft->>name,description:draft->>description,tags:draft->tags,cover_asset_id,state,visibility,review_status,review_message,revision,submitted_revision,published_revision,approved_revision,created_at,updated_at';

export async function creatorRuntime(draft: CharacterDraft) {
  const selected = await resolveCreatorPresets(draft.selectedPresetIds);
  return {
    name: draft.name,
    description: draft.description,
    first_mes: draft.opening,
    system_prompt: composeCharacterSystemPrompt(draft, selected),
  };
}
async function summary(row: SummaryRow): Promise<CreatorCharacterSummary> {
  return {
    id: row.character_id,
    owner_user_id: row.owner_user_id,
    name: row.name,
    description: row.description,
    tags: row.tags,
    cover_asset_id: row.cover_asset_id,
    cover_url: row.cover_asset_id ? await resolveCreatorCoverUrl(row.cover_asset_id) : null,
    state: row.state,
    visibility: row.visibility,
    review_status: row.review_status,
    review_message: row.review_message,
    revision: row.revision,
    submitted_revision: row.submitted_revision,
    published_revision: row.published_revision,
    approved_revision: row.approved_revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
async function detail(row: CreationRow): Promise<CreatorCharacter> {
  const draft = CharacterDraftSchema.parse(row.draft);
  return {
    ...(await summary({
      ...row,
      name: draft.name,
      description: draft.description,
      tags: draft.tags,
    })),
    draft,
  };
}

export class CreatorCharacterRepository {
  private get db() {
    return getDomainDb('app_core');
  }
  async list(ownerId: string): Promise<CreatorCharacterSummary[]> {
    const { data, error } = await this.db
      .from('character_creations')
      .select(SUMMARY_COLUMNS)
      .eq('owner_user_id', ownerId)
      .order('updated_at', { ascending: false })
      .limit(200)
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw error;
    return Promise.all(((data ?? []) as unknown as SummaryRow[]).map(summary));
  }
  async get(id: string, ownerId?: string): Promise<CreatorCharacter> {
    let query = this.db.from('character_creations').select('*').eq('character_id', id);
    if (ownerId) query = query.eq('owner_user_id', ownerId);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(TIMEOUT_MS)).maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('角色不存在'), { code: 'P0404' });
    return detail(data as CreationRow);
  }
  async mutate(input: {
    ownerId: string;
    id: string;
    action: 'create' | 'save' | 'publish' | 'visibility';
    expectedRevision?: number;
    draft?: CharacterDraft;
    coverAssetId?: string | null;
    visibility?: CreatorVisibility;
  }): Promise<CreatorCharacter> {
    const draft = input.draft ?? emptyCharacterDraft();
    const payload =
      input.action === 'create' || input.action === 'save'
        ? {
            draft,
            runtime: await creatorRuntime(draft),
            cover_asset_id: input.coverAssetId ?? null,
          }
        : { visibility: input.visibility };
    const { data, error } = await this.db
      .rpc('mutate_creator_character', {
        p_user_id: input.ownerId,
        p_character_id: input.id,
        p_action: input.action,
        p_expected_revision: input.expectedRevision ?? null,
        p_payload: payload,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw error;
    return detail(data as CreationRow);
  }
  async reviews(status: CreatorReviewStatus): Promise<CreatorCharacterSummary[]> {
    const { data, error } = await this.db
      .from('character_creations')
      .select(SUMMARY_COLUMNS)
      .eq('review_status', status)
      .order('updated_at', { ascending: true })
      .limit(100)
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw error;
    return Promise.all(((data ?? []) as unknown as SummaryRow[]).map(summary));
  }
  async review(input: {
    adminId: string;
    id: string;
    submittedRevision: number;
    decision: 'approve' | 'reject';
    reason?: string;
    environment: 'test' | 'production';
  }): Promise<CreatorCharacter> {
    const { data, error } = await this.db
      .rpc('review_creator_character', {
        p_admin_user_id: input.adminId,
        p_character_id: input.id,
        p_submitted_revision: input.submittedRevision,
        p_decision: input.decision,
        p_reason: input.reason ?? null,
        p_environment: input.environment,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw error;
    return detail(data as CreationRow);
  }
}
