/**
 * 增长弹窗（进群 / VIP）的本地虚构数据。只有两个专用场景会返回弹窗，其它场景一律为空，
 * 避免影响既有界面用例。点「立即进群领取」后，下一次社群入口查询返回已领取，用来演示到账提示。
 */
export type GrowthPromptScenario = 'growth-community' | 'growth-vip';

const COMMUNITY_PROMPT = {
  kind: 'community',
  at_rounds: 13,
  reward_credits: 500,
  telegram_url: 'https://t.me/preview_community',
  fallback_handle: '@preview_community',
};
const VIP_PROMPT = {
  kind: 'vip',
  at_rounds: 50,
  price_cents: 3888,
  duration_days: 31,
  bonus_credits: 3000,
  checkin_daily_credits: 150,
};

export function createGrowthPromptFixture() {
  let communityAccepted = false;
  const events: Array<{ kind: string; event: string }> = [];
  return {
    reset() {
      communityAccepted = false;
      events.length = 0;
    },
    events,
    /** 进群卡点过主按钮后，社群入口改报已领取。 */
    get communityRewarded() {
      return communityAccepted;
    },
    handle(method: string, path: string, body: unknown, scenario: string): unknown | undefined {
      if (path === '/api/growth/prompts' && method === 'GET') {
        if (scenario === 'growth-community')
          return { total_rounds: 13, prompts: [COMMUNITY_PROMPT] };
        if (scenario === 'growth-vip') return { total_rounds: 50, prompts: [VIP_PROMPT] };
        return { total_rounds: 0, prompts: [] };
      }
      if (path === '/api/growth/prompts/events' && method === 'POST') {
        const record = (body ?? {}) as { kind?: string; event?: string };
        events.push({ kind: String(record.kind), event: String(record.event) });
        if (record.kind === 'community' && record.event === 'accepted') communityAccepted = true;
        return { recorded: true };
      }
      return undefined;
    },
  };
}
