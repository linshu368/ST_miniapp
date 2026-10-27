import type { DramaSummary } from '@miniapp/shared';

export function selectDramas(
  dramas: DramaSummary[],
  keyword: string,
  category: string,
  sort: 'recommended' | 'latest'
): DramaSummary[] {
  const terms = [keyword, category === '全部' ? '' : category]
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  // 每个条件可分别命中任一完整字段；分类与搜索取交集，不使用卡片截断后的文字。
  const selected = dramas.filter((drama) => {
    const fields = [drama.title, ...drama.tags, drama.description].map((field) =>
      field.toLowerCase()
    );
    return terms.every((term) => fields.some((field) => field.includes(term)));
  });
  if (sort === 'latest') {
    const time = (drama: DramaSummary) => {
      const parsed = drama.first_published_at ? Date.parse(drama.first_published_at) : NaN;
      return Number.isFinite(parsed) ? parsed : -Infinity;
    };
    selected.sort((a, b) => {
      const aTime = time(a);
      const bTime = time(b);
      if (aTime !== bTime) return aTime > bTime ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
  return selected;
}
