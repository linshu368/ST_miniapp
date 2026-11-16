import { getDomainDb } from '../../lib/supabase.js';
import { createLogger } from '../../lib/logger.js';
import {
  CHECKIN_NEW_USER_CREDITS_CONFIG_KEY,
  CHECKIN_VETERAN_CREDITS_CONFIG_KEY,
  DEFAULT_CHECKIN_NEW_USER_CREDITS,
  DEFAULT_CHECKIN_VETERAN_CREDITS,
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  getNextDailyCheckinAt,
  parseCheckinTierCredits,
  type VipCheckinBonusConfig,
} from '@miniapp/shared';
import { quoteDailyCheckinReward } from '../../features/vip/checkin-reward.js';
import type { DailyCheckinStatus } from './wallet-model.js';

export async function getDailyCheckinStatus(
  db: ReturnType<typeof getDomainDb>,
  appCoreDb: ReturnType<typeof getDomainDb>,
  featuresDb: ReturnType<typeof getDomainDb>,
  userId: string,
  input: {
    createdAt: string;
    vipCredits?: VipCheckinBonusConfig;
  }
): Promise<DailyCheckinStatus> {
  const { data: configRows, error: configError } = await appCoreDb
    .from('runtime_config')
    .select('key, value, text_value')
    .in('key', [CHECKIN_NEW_USER_CREDITS_CONFIG_KEY, CHECKIN_VETERAN_CREDITS_CONFIG_KEY]);

  if (configError) {
    throw new Error(`查询签到配置失败：${configError.message}`, { cause: configError });
  }

  const byKey = new Map(
    (
      (configRows as Array<{ key: string; value: unknown; text_value: string | null }> | null) ?? []
    ).map((row) => [row.key, row])
  );
  const newUserRow = byKey.get(CHECKIN_NEW_USER_CREDITS_CONFIG_KEY);
  const veteranRow = byKey.get(CHECKIN_VETERAN_CREDITS_CONFIG_KEY);
  const newUserCredits = parseCheckinTierCredits(
    newUserRow?.value ?? newUserRow?.text_value,
    DEFAULT_CHECKIN_NEW_USER_CREDITS
  );
  const veteranCredits = parseCheckinTierCredits(
    veteranRow?.value ?? veteranRow?.text_value,
    DEFAULT_CHECKIN_VETERAN_CREDITS
  );

  const now = new Date();

  const { data: membership, error: membershipError } = await db
    .from('vip_memberships')
    .select('valid_until')
    .eq('user_id', userId)
    .maybeSingle();
  if (membershipError) {
    createLogger('wallet').sys.error(
      { err: membershipError, event: 'wallet.checkin.vip_read_failed', userId },
      '签到预览读取 VIP 失败'
    );
  }
  const validUntil = membershipError
    ? null
    : ((membership as { valid_until?: string } | null)?.valid_until ?? null);
  const quote = quoteDailyCheckinReward({
    createdAt: input.createdAt,
    validUntil,
    now: now.toISOString(),
    vipCredits: input.vipCredits ?? DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
    newUserCredits,
    veteranCredits,
  });

  const { data, error } = await featuresDb
    .from('daily_checkins')
    .select('claimed_at')
    .eq('user_id', userId)
    .order('claimed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`查询签到状态失败：${error.message}`, { cause: error });
  }

  const lastClaimedAt = (data as { claimed_at?: string } | null)?.claimed_at ?? null;
  const nextClaimAt = lastClaimedAt ? getNextDailyCheckinAt(lastClaimedAt) : null;

  return {
    can_claim: !nextClaimAt || now.getTime() >= new Date(nextClaimAt).getTime(),
    last_claimed_at: lastClaimedAt,
    next_claim_at: nextClaimAt,
    reward_credits: quote.reward_credits,
    base_reward_credits: quote.base_reward_credits,
    vip_reward_credits: quote.vip_reward_credits,
    main_reward_credits: quote.main_reward_credits,
    bonus_reward_credits: quote.bonus_reward_credits,
  };
}
