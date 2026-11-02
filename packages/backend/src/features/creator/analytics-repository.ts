import { CreatorAnalyticsDataSchema, type CreatorAnalyticsQuery } from '@miniapp/shared';
import { prisma } from '../../lib/db.js';
import { resolveCreatorCoverUrl } from './covers.js';
import { toCharacterComment } from '../character-social/repository.js';
import { buildCreatorAnalyticsQuery } from './analytics-query.js';

function row(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid analytics row');
  return input as Record<string, unknown>;
}
function list(input: unknown): unknown[] {
  if (!Array.isArray(input)) throw new Error('Invalid analytics list');
  return input;
}

export async function getCreatorAnalytics(ownerId: string, query: CreatorAnalyticsQuery) {
  const rows = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '6s'`;
      return tx.$queryRaw<Array<{ allowed: boolean; data: Record<string, unknown> }>>(
        buildCreatorAnalyticsQuery(ownerId, query)
      );
    },
    { maxWait: 2_000, timeout: 8_000 }
  );
  const result = rows[0];
  if (!result?.allowed)
    throw Object.assign(new Error('Character not owned'), { code: 'NOT_FOUND' });
  const urls = new Map<string, Promise<string | null>>();
  const card = async (input: unknown) => {
    const parsed = row(input);
    const asset = typeof parsed.cover_asset_id === 'string' ? parsed.cover_asset_id : null;
    if (asset && !urls.has(asset))
      urls.set(
        asset,
        resolveCreatorCoverUrl(asset).catch(() => null)
      );
    return { ...parsed, cover_url: asset ? await urls.get(asset) : null };
  };
  const comment = (input: unknown) => {
    const parsed = row(input);
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.user_id !== 'string' ||
      typeof parsed.body !== 'string' ||
      typeof parsed.created_at !== 'string'
    )
      throw new Error('Invalid analytics comment');
    const { user_id: _userId, ...rest } = parsed;
    return {
      ...rest,
      author: toCharacterComment(
        {
          id: parsed.id,
          user_id: parsed.user_id,
          body: parsed.body,
          created_at: parsed.created_at,
        },
        ownerId
      ).author,
    };
  };
  const data = result.data;
  if (query.section === 'overview') {
    data.works = await Promise.all(list(data.works).map(card));
    data.selected = data.selected ? await card(data.selected) : null;
    data.feedback = list(data.feedback).map(comment);
  } else if (query.section === 'characters' || query.section === 'works') {
    data.items = await Promise.all(list(data.items).map(card));
  } else if (query.section === 'feedback') {
    data.items = list(data.items).map(comment);
  }
  // Runtime validation also strips internal asset IDs / comment identities before returning to the browser.
  return CreatorAnalyticsDataSchema.parse(data);
}
