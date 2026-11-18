import { PlazaFeedItemSchema, type PlazaWork } from '@miniapp/shared';

/** Synthetic preordered catalog, not a second implementation of the production ranking. */
export function plazaFeedFixture(works: PlazaWork[], url: URL, longList: boolean) {
  const source = longList
    ? Array.from({ length: 60 }, (_, index) => {
        const template = works[index % 3 === 0 ? 1 : 0]!;
        return {
          ...template,
          id: `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`,
          width: 1000,
          height: [3000, 500, 500, 1200][index % 4]!,
          title: `分页作品 ${index + 1}`,
          like_count: index === 0 ? 2 : 0,
          published_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        };
      })
    : works;
  const media = url.searchParams.get('media') ?? 'all';
  const search = url.searchParams.get('search')?.toLowerCase() ?? '';
  const filtered = source.filter(
    (work) =>
      (media === 'all' || work.media_type === media) && work.title.toLowerCase().includes(search)
  );
  if (url.searchParams.get('sort') === 'latest')
    filtered.sort((a, b) => b.published_at.localeCompare(a.published_at));
  const cursor = url.searchParams.get('cursor');
  const offset = cursor?.startsWith('plaza-fixture-')
    ? Number(cursor.slice('plaza-fixture-'.length))
    : 0;
  return {
    items: filtered.slice(offset, offset + 20).map((work) => PlazaFeedItemSchema.parse(work)),
    next_cursor: filtered.length > offset + 20 ? `plaza-fixture-${offset + 20}` : null,
  };
}
