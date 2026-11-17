import { CreatorAnalyticsDataSchema, type CreatorAnalyticsQuery } from '@miniapp/shared';
/** Fictional local-preview data. Never read by an authenticated production API. */
export const ANALYTICS_PERIODS = [
  { id: 'all', label: '累计' },
  { id: '7d', label: '近7天' },
  { id: '30d', label: '近30天' },
] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number]['id'];
export type CreatorAnalyticsCard = {
  id: string;
  name: string;
  visibility: 'public' | 'private';
  tone: number;
  createdDaysAgo: number;
};
export const ANALYTICS_CARDS: CreatorAnalyticsCard[] = [
  { id: 'bookshop', name: '旧书店的林舟', visibility: 'public', tone: 2, createdDaysAgo: 48 },
  { id: 'rain', name: '雨夜来信', visibility: 'private', tone: 0, createdDaysAgo: 32 },
  { id: 'ocean', name: '深海来客', visibility: 'public', tone: 1, createdDaysAgo: 18 },
  { id: 'street', name: '长街未眠', visibility: 'public', tone: 2, createdDaysAgo: 6 },
  { id: 'moon', name: '月亮停在窗前', visibility: 'private', tone: 0, createdDaysAgo: 2 },
];
type Usage = { card: string; player: string; daysAgo: number; rounds: number };
export type PreviewReward = { id: string; card: string; daysAgo: number; amount: number };
export type PreviewFeedback = {
  id: string;
  card: string;
  daysAgo: number;
  author: string;
  body: string;
};
const usages: Usage[] = [];
const counts = [76, 24, 36, 18, 0];
ANALYTICS_CARDS.forEach((card, index) => {
  for (let i = 0; i < counts[index]!; i++) {
    const player = `player-${index === 0 ? i : index === 1 ? i + 64 : index === 2 ? i + 80 : i + 112}`;
    const daysAgo = i % (index === 3 ? 6 : index === 2 ? 18 : 42);
    usages.push({
      card: card.id,
      player,
      daysAgo,
      rounds: index === 3 ? 1 + (i % 4) : 2 + ((i * 7) % 27),
    });
    if (i % 3 === 0 && index < 3) {
      usages.push({
        card: card.id,
        player,
        daysAgo: Math.max(0, daysAgo - 2),
        rounds: 8 + (i % 12),
      });
    }
  }
  // Self-testing exists in the source but never contributes to audience or rewards.
  usages.push({ card: card.id, player: 'creator', daysAgo: 0, rounds: 83 });
});
export const PREVIEW_REWARDS: PreviewReward[] = [
  { id: 'r1', card: 'bookshop', daysAgo: 0, amount: 248 },
  { id: 'r2', card: 'rain', daysAgo: 0, amount: 96 },
  { id: 'r3', card: 'ocean', daysAgo: 1, amount: 128 },
  { id: 'r4', card: 'bookshop', daysAgo: 1, amount: 312 },
  { id: 'r5', card: 'rain', daysAgo: 2, amount: 174 },
  { id: 'r6', card: 'bookshop', daysAgo: 3, amount: 420 },
  { id: 'r7', card: 'bookshop', daysAgo: 4, amount: -24 },
  { id: 'r8', card: 'ocean', daysAgo: 5, amount: 172 },
  { id: 'r9', card: 'bookshop', daysAgo: 8, amount: 680 },
  { id: 'r10', card: 'rain', daysAgo: 12, amount: 716 },
  { id: 'r11', card: 'ocean', daysAgo: 14, amount: 200 },
  { id: 'r12', card: 'bookshop', daysAgo: 25, amount: 660 },
  { id: 'r13', card: 'bookshop', daysAgo: 36, amount: 504 },
];
export const PREVIEW_FEEDBACK: PreviewFeedback[] = [
  {
    id: 'f1',
    card: 'bookshop',
    daysAgo: 0,
    author: '旅人 037',
    body: '林舟会记得前面聊过的小事，越聊越像真的认识了很久。',
  },
  {
    id: 'f2',
    card: 'rain',
    daysAgo: 1,
    author: '旅人 128',
    body: '喜欢这种欲言又止的感觉，昨天没聊完，今天又回来了。',
  },
  {
    id: 'f3',
    card: 'ocean',
    daysAgo: 2,
    author: '旅人 064',
    body: '世界观很有意思，希望开场能多一点让我接话的空间。',
  },
  {
    id: 'f4',
    card: 'street',
    daysAgo: 3,
    author: '旅人 015',
    body: '刚开始玩，人物说话的语气很自然，先收藏了。',
  },
  {
    id: 'f5',
    card: 'bookshop',
    daysAgo: 10,
    author: '旅人 082',
    body: '开场那封信一下就把我带进去了。',
  },
];
function inPeriod(daysAgo: number, period: AnalyticsPeriod) {
  return period === 'all' || daysAgo < (period === '7d' ? 7 : 30);
}
export function getPreviewAnalytics(period: AnalyticsPeriod, cardId: string | null, empty = false) {
  const matches = (row: { card: string; daysAgo: number }) =>
    (!cardId || row.card === cardId) && inPeriod(row.daysAgo, period);
  const usage = empty ? [] : usages.filter((row) => row.player !== 'creator' && matches(row));
  const rewards = empty ? [] : PREVIEW_REWARDS.filter(matches);
  const feedback = empty ? [] : PREVIEW_FEEDBACK.filter(matches);
  const perPlayerCard = new Map<string, { player: string; rounds: number; dates: Set<number> }>();
  usage.forEach((row) => {
    const key = `${row.player}:${row.card}`;
    const entry = perPlayerCard.get(key) ?? {
      player: row.player,
      rounds: 0,
      dates: new Set<number>(),
    };
    entry.rounds += row.rounds;
    entry.dates.add(row.daysAgo);
    perPlayerCard.set(key, entry);
  });
  const players = new Set(usage.map((row) => row.player)).size;
  const deepPlayers = new Set(
    [...perPlayerCard.values()].filter((row) => row.rounds >= 10).map((row) => row.player)
  ).size;
  const returningPlayers = new Set(
    [...perPlayerCard.values()].filter((row) => row.dates.size >= 2).map((row) => row.player)
  ).size;
  return {
    players,
    rounds: usage.reduce((sum, row) => sum + row.rounds, 0),
    earned: rewards.reduce((sum, row) => sum + row.amount, 0),
    todayEarned: rewards
      .filter((row) => row.daysAgo === 0)
      .reduce((sum, row) => sum + row.amount, 0),
    deepPlayers,
    returningPlayers,
    rewards,
    feedback,
    // Public interaction examples follow the same card and period selection.
    likes: usage.reduce((sum, row) => sum + Math.floor(row.rounds / 5), 0),
    favorites: new Set(
      usage.filter((row) => row.rounds >= 12).map((row) => `${row.card}:${row.player}`)
    ).size,
  };
}

const uuid = (index: number) => `73000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
export function makeCreatorAnalytics(query: CreatorAnalyticsQuery, api: string, empty = false) {
  const end = query.as_of ?? new Date().toISOString();
  const stamp = (days: number) =>
    new Date(new Date(end).getTime() - days * 86_400_000 - 60_000).toISOString();
  const rawCard = ANALYTICS_CARDS.find((_, i) => uuid(i) === query.character_id);
  const sample = getPreviewAnalytics(query.period, rawCard?.id ?? null, empty);
  const card = (item: CreatorAnalyticsCard, i: number) => ({
    id: uuid(i),
    name: item.name,
    visibility: item.visibility,
    state: 'ready' as const,
    cover_url: `${api}/assets/scene.svg?tone=${item.tone}`,
    created_at: stamp(item.createdDaysAgo),
  });
  const cards = empty ? [] : ANALYTICS_CARDS.map(card);
  const works = cards
    .filter((c) => !query.character_id || c.id === query.character_id)
    .map((c) => ({
      ...c,
      stats: getPreviewAnalytics(
        query.period,
        ANALYTICS_CARDS[cards.findIndex((x) => x.id === c.id)]!.id
      ),
    }))
    .sort((a, b) =>
      query.sort === 'newest'
        ? b.created_at.localeCompare(a.created_at)
        : b.stats[query.sort] - a.stats[query.sort]
    );
  const rewards = sample.rewards.map((r) => ({
    id: r.id,
    character_id: uuid(ANALYTICS_CARDS.findIndex((c) => c.id === r.card)),
    name: ANALYTICS_CARDS.find((c) => c.id === r.card)!.name,
    amount: r.amount,
    occurred_at: stamp(r.daysAgo),
    kind: r.amount < 0 ? ('reversal' as const) : ('credit' as const),
  }));
  const feedback = sample.feedback.map((f) => ({
    id: `74000000-0000-4000-8000-${f.id.slice(1).padStart(12, '0')}`,
    character_id: uuid(ANALYTICS_CARDS.findIndex((c) => c.id === f.card)),
    name: ANALYTICS_CARDS.find((c) => c.id === f.card)!.name,
    author: f.author,
    body: f.body,
    created_at: stamp(f.daysAgo),
  }));
  if (query.section === 'overview') {
    const social = getPreviewAnalytics('all', rawCard?.id ?? null, empty);
    return CreatorAnalyticsDataSchema.parse({
      section: 'overview',
      as_of: end,
      card_count: cards.length,
      selected: cards.find((c) => c.id === query.character_id) ?? null,
      summary: {
        ...sample,
        likes: social.likes,
        favorites: social.favorites,
        comments: feedback.length,
      },
      works: works.slice(0, 3),
      works_total: works.length,
      rewards: rewards.slice(0, 3),
      rewards_total: rewards.length,
      feedback: feedback.slice(0, 3),
      feedback_total: feedback.length,
    });
  }
  const items =
    query.section === 'works'
      ? works
      : query.section === 'characters'
        ? cards
        : query.section === 'rewards'
          ? rewards
          : feedback;
  return CreatorAnalyticsDataSchema.parse({
    section: query.section,
    as_of: end,
    page: query.page,
    page_size: query.page_size,
    total: items.length,
    items: items.slice((query.page - 1) * query.page_size, query.page * query.page_size),
  });
}
