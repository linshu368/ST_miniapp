import { createHash } from 'node:crypto';
import type { DramaComment, DramaSocial, GetDramaCommentsData } from '@miniapp/shared';
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
export interface CommentCursor {
  at: string;
  id: string;
}

export function decodeCommentCursor(value: string): CommentCursor | null {
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !('at' in parsed) || !('id' in parsed))
      return null;
    const { at, id } = parsed;
    if (
      typeof at !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(at) ||
      !Number.isFinite(Date.parse(at))
    )
      return null;
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    )
      return null;
    return { at, id };
  } catch {
    return null;
  }
}

function commentDto(row: CommentRow, viewerId: string): DramaComment {
  return {
    id: row.id,
    author: `剧友 ${createHash('sha256').update(`drama-viewer:${row.user_id}`).digest('hex').slice(0, 6)}`,
    is_mine: row.user_id === viewerId,
    body: row.body,
    created_at: row.created_at,
  };
}

/** Short-drama-only writes; archive metadata remains read-only. */
export class DramaInteractionRepository {
  private get db() {
    return getDomainDb('drama_archive');
  }

  async exists(dramaId: string) {
    const result = await this.db
      .from('dramas')
      .select('id')
      .eq('id', dramaId)
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS))
      .maybeSingle();
    if (result.error) throw result.error;
    return Boolean(result.data);
  }

  async social(dramaId: string, userId: string): Promise<DramaSocial> {
    const [likes, comments, mine] = await Promise.all([
      this.db
        .from('drama_likes')
        .select('*', { count: 'exact', head: true })
        .eq('drama_id', dramaId)
        .abortSignal(AbortSignal.timeout(TIMEOUT_MS)),
      this.db
        .from('drama_comments')
        .select('*', { count: 'exact', head: true })
        .eq('drama_id', dramaId)
        .is('deleted_at', null)
        .abortSignal(AbortSignal.timeout(TIMEOUT_MS)),
      this.db
        .from('drama_likes')
        .select('drama_id')
        .eq('drama_id', dramaId)
        .eq('user_id', userId)
        .abortSignal(AbortSignal.timeout(TIMEOUT_MS))
        .maybeSingle(),
    ]);
    for (const result of [likes, comments, mine]) if (result.error) throw result.error;
    return {
      liked: Boolean(mine.data),
      like_count: likes.count ?? 0,
      comment_count: comments.count ?? 0,
    };
  }

  async setLike(dramaId: string, userId: string, liked: boolean) {
    const query = liked
      ? this.db
          .from('drama_likes')
          .upsert(
            { drama_id: dramaId, user_id: userId },
            { onConflict: 'drama_id,user_id', ignoreDuplicates: true }
          )
      : this.db.from('drama_likes').delete().eq('drama_id', dramaId).eq('user_id', userId);
    const result = await query.abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (result.error) throw result.error;
    return this.social(dramaId, userId);
  }

  async comments(
    dramaId: string,
    userId: string,
    cursor: CommentCursor | null
  ): Promise<GetDramaCommentsData> {
    let query = this.db
      .from('drama_comments')
      .select(COLUMNS)
      .eq('drama_id', dramaId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE_SIZE + 1);
    // Both fields were strictly validated before interpolation into PostgREST's filter grammar.
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
      comments: visible.map((row) => commentDto(row, userId)),
      next_cursor:
        rows.length > PAGE_SIZE && last
          ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString('base64url')
          : null,
    };
  }

  async createComment(
    dramaId: string,
    userId: string,
    id: string,
    body: string
  ): Promise<DramaComment> {
    const result = await this.db
      .rpc('create_drama_comment', {
        p_id: id,
        p_drama_id: dramaId,
        p_user_id: userId,
        p_body: body,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS))
      .single();
    if (result.error) throw result.error;
    return commentDto(result.data as CommentRow, userId);
  }

  async deleteComment(dramaId: string, userId: string, id: string) {
    // Keep a tombstone for rate limiting and to prevent an old retry from resurrecting a deletion.
    const result = await this.db
      .from('drama_comments')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('drama_id', dramaId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (result.error) throw result.error;
  }
}
