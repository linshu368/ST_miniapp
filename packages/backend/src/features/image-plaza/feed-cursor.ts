import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  IMAGE_PLAZA_INVALID_CURSOR,
  ImagePlazaFeedCursorSchema as schema,
  type ImagePlazaFeedSort,
  type ImagePlazaFeedCursor,
} from '@miniapp/shared';
export type FeedCursor = ImagePlazaFeedCursor;

export function feedFilter(search?: string, tagLabel?: string): string {
  return createHash('sha256')
    .update(JSON.stringify([search?.trim() ?? '', tagLabel?.trim() ?? '']))
    .digest('hex');
}

export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(schema.parse(cursor))).toString('base64url');
}

export function decodeFeedCursor(
  value: string | undefined,
  sort: ImagePlazaFeedSort,
  filter: string
): FeedCursor | null {
  if (!value) return null;
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = schema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (cursor.sort !== sort || cursor.filter !== filter) throw new Error();
    return cursor;
  } catch {
    throw new Error(IMAGE_PLAZA_INVALID_CURSOR);
  }
}

export function cursorFilter(cursor: FeedCursor): string {
  const time = `published_at.lt.${cursor.publishedAt}`;
  const tie = `and(published_at.eq.${cursor.publishedAt},id.lt.${cursor.id})`;
  if (cursor.partition === 'latest') return `${time},${tie}`;
  if (cursor.partition === 'liked')
    return [
      `like_count.lt.${cursor.likeCount}`,
      `and(like_count.eq.${cursor.likeCount},${time})`,
      `and(like_count.eq.${cursor.likeCount},published_at.eq.${cursor.publishedAt},id.lt.${cursor.id})`,
    ].join(',');
  if (cursor.order === null) return `and(initial_feed_order.is.null,or(${time},${tie}))`;
  return [
    `initial_feed_order.gt.${cursor.order}`,
    'initial_feed_order.is.null',
    `and(initial_feed_order.eq.${cursor.order},or(${time},${tie}))`,
  ].join(',');
}
