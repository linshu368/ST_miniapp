import { Prisma } from '@prisma/client';

export const PUBLIC_CREATOR_PAGE_SIZE = 12;

/** This alias identifies a space across works and name changes. Access still depends on visible works. */
export function publicCreatorIdSql(ownerColumn: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`md5('st-public-creator-v1:' || ${ownerColumn}::text)::uuid`;
}

export function publicAuthorName(
  profile: { display_name: string | null; tg_first_name: string | null } | null
): string {
  return profile?.display_name?.trim() || profile?.tg_first_name?.trim() || '匿名作者';
}

export type PublicAuthorPageRow = {
  display_name: string | null;
  tg_first_name: string | null;
  has_more: boolean;
  cards: {
    id: string;
    name: string;
    description: string;
    avatar_url: string;
    tags: unknown;
    like_count: number;
    favorite_count: number;
  }[];
};

export function buildPublicCreatorPageQuery(publicId: string, page: number): Prisma.Sql {
  // The ownership row is already joined here: apply the same UGC visibility criteria as
  // can_discover_character directly, instead of running a second lookup for each candidate.
  const listed = Prisma.sql`c.enabled AND c.archived_at IS NULL AND NOT c.is_test
    AND cr.state = 'ready' AND cr.visibility = 'public' AND cr.approved_revision IS NOT NULL`;
  return Prisma.sql`
    WITH author AS MATERIALIZED (
      SELECT cr.owner_user_id
      FROM app_core.character_creations cr JOIN app_core.characters c ON c.id = cr.character_id
      WHERE ${publicCreatorIdSql(Prisma.sql`cr.owner_user_id`)} = ${publicId}::uuid AND ${listed}
      LIMIT 1
    ), probe AS MATERIALIZED (
      SELECT c.id, c.last_listed_at, c.created_at
      FROM author a JOIN app_core.character_creations cr ON cr.owner_user_id = a.owner_user_id
      JOIN app_core.characters c ON c.id = cr.character_id
      WHERE ${listed}
      ORDER BY c.last_listed_at DESC NULLS LAST, c.created_at DESC, c.id DESC
      LIMIT ${PUBLIC_CREATOR_PAGE_SIZE + 1} OFFSET ${(page - 1) * PUBLIC_CREATOR_PAGE_SIZE}
    ), shown AS MATERIALIZED (
      SELECT * FROM probe ORDER BY last_listed_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT ${PUBLIC_CREATOR_PAGE_SIZE}
    ), reply_likes AS MATERIALIZED (
      -- Only ask the private chat domain for aggregate counts on visible cards. Its
      -- accessor accepts 1..40 IDs; an empty page must not invoke it.
      SELECT counts.* FROM (SELECT array_agg(id) AS ids FROM shown HAVING count(*) > 0) batch
      CROSS JOIN LATERAL experience.get_character_reply_like_counts(batch.ids) counts
    )
    SELECT s.display_name, s.tg_first_name, (SELECT count(*) FROM probe) > ${PUBLIC_CREATOR_PAGE_SIZE} AS has_more,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', c.id, 'name', c.name, 'description', left(c.description,120), 'avatar_url', c.avatar_url, 'tags', c.tags,
          'like_count', (SELECT count(*) FROM miniapp_features.character_likes l WHERE l.character_id = c.id)
            + coalesce(r.reply_like_count, 0),
          'favorite_count', (SELECT count(*) FROM miniapp_features.character_favorites f WHERE f.character_id = c.id)
        ) ORDER BY w.last_listed_at DESC NULLS LAST, w.created_at DESC, w.id DESC)
        FROM shown w JOIN app_core.characters c ON c.id = w.id
        LEFT JOIN reply_likes r ON r.character_id = c.id
      ), '[]'::jsonb) AS cards
    FROM author a LEFT JOIN app_core.miniapp_user_settings s ON s.user_id = a.owner_user_id
  `;
}
