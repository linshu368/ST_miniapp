import { createHash } from 'node:crypto';
import type {
  CharacterComment,
  CharacterSocial,
  GetCharacterCommentsData,
  GetCharacterSocialsData,
  ReportCharacterComment,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';

const TIMEOUT_MS = 5000;
const PAGE_SIZE = 20;
const COLUMNS = 'id,user_id,body,created_at';
interface CommentRow {
  id: string;
  user_id: string;
  body: string;
  created_at: string;
}
export interface CharacterCommentCursor {
  at: string;
  id: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function decodeCharacterCommentCursor(value: string): CharacterCommentCursor | null {
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !('at' in parsed) || !('id' in parsed))
      return null;
    const { at, id } = parsed;
    if (
      typeof at !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(at) ||
      !Number.isFinite(Date.parse(at)) ||
      typeof id !== 'string' ||
      !UUID.test(id)
    )
      return null;
    return { at, id };
  } catch {
    return null;
  }
}

export function toCharacterComment(row: CommentRow, viewerId: string): CharacterComment {
  return {
    id: row.id,
    author: `同好 ${createHash('sha256').update(`character-comment:${row.user_id}`).digest('hex').slice(0, 8)}`,
    is_mine: row.user_id === viewerId,
    body: row.body,
    created_at: row.created_at,
  };
}

/** Public character interactions; favorites keep their existing authoritative relationship. */
export class CharacterSocialRepository {
  private get db() {
    return getDomainDb('miniapp_features');
  }

  async exists(id: string) {
    const result = await getDomainDb('app_core')
      .from('characters')
      .select('id')
      .eq('id', id)
      .eq('enabled', true)
      .is('archived_at', null)
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS))
      .maybeSingle();
    if (result.error) throw result.error;
    return Boolean(result.data);
  }

  async socials(ids: string[], userId: string): Promise<GetCharacterSocialsData['socials']> {
    const result = await this.db
      .rpc('get_character_socials', { p_character_ids: ids, p_user_id: userId })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (result.error) throw result.error;
    return (result.data ?? []) as GetCharacterSocialsData['socials'];
  }

  async social(id: string, userId: string): Promise<CharacterSocial> {
    const rows = await this.socials([id], userId);
    const row = rows[0];
    if (!row) throw Object.assign(new Error('Character unavailable'), { code: 'P0404' });
    return {
      liked: row.liked,
      like_count: row.like_count,
      favorite_count: row.favorite_count,
      comment_count: row.comment_count,
    };
  }

  async setLike(id: string, userId: string, liked: boolean): Promise<CharacterSocial> {
    const result = await this.db
      .rpc('set_character_like', { p_character_id: id, p_user_id: userId, p_liked: liked })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS))
      .single();
    if (result.error) throw result.error;
    const row = result.data as CharacterSocial;
    return {
      liked: row.liked,
      like_count: row.like_count,
      favorite_count: row.favorite_count,
      comment_count: row.comment_count,
    };
  }

  async comments(
    id: string,
    userId: string,
    cursor: CharacterCommentCursor | null
  ): Promise<GetCharacterCommentsData> {
    let query = this.db
      .from('character_comments')
      .select(COLUMNS)
      .eq('character_id', id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE_SIZE + 1);
    // Cursor fields have strict validation before entering PostgREST filter grammar.
    if (cursor)
      query = query.or(
        `created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`
      );
    const result = await query.abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (result.error) throw result.error;
    const rows = (result.data ?? []) as CommentRow[];
    const visible = rows.slice(0, PAGE_SIZE);
    const last = visible.at(-1);
    return {
      comments: visible.map((row) => toCharacterComment(row, userId)),
      next_cursor:
        rows.length > PAGE_SIZE && last
          ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString('base64url')
          : null,
    };
  }

  async createComment(
    characterId: string,
    userId: string,
    id: string,
    body: string
  ): Promise<CharacterComment> {
    const result = await this.db
      .rpc('create_character_comment', {
        p_id: id,
        p_character_id: characterId,
        p_user_id: userId,
        p_body: body,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS))
      .single();
    if (result.error) throw result.error;
    return toCharacterComment(result.data as CommentRow, userId);
  }

  async deleteComment(characterId: string, userId: string, id: string) {
    const result = await this.db
      .rpc('delete_character_comment', { p_id: id, p_character_id: characterId, p_user_id: userId })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (result.error) throw result.error;
  }

  async reportComment(
    characterId: string,
    userId: string,
    id: string,
    reason: ReportCharacterComment['reason']
  ) {
    const result = await this.db
      .rpc('report_character_comment', {
        p_id: id,
        p_character_id: characterId,
        p_user_id: userId,
        p_reason: reason,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (result.error) throw result.error;
  }
}
