/**
 * 短剧原因问卷（一次性）。答卷在 miniapp_analytics（不经 PostgREST），线上只写不读；
 * "是否已领过奖励"看 billing.wallet_ledger，提交与发奖由 billing.submit_drama_survey 在同一事务里完成。
 * 问卷结束后整块删除（见 migrations/20261113_drama_survey.sql 文件头）。
 */
import {
  DRAMA_SURVEY_KEY,
  SubmitDramaSurveyDataSchema,
  type ParsedDismissDramaSurveyRequest,
  type ParsedSubmitDramaSurveyRequest,
} from '@miniapp/shared';
import { prisma } from '../../lib/db.js';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';
import { fetchRuntimeConfigEntry } from '../../platform/runtime-config.js';

export const DRAMA_SURVEY_ENABLED_KEY = 'miniapp_drama_survey_enabled';
const TIMEOUT_MS = 5000;

export class DramaSurveyError extends Error {
  constructor(readonly code: string) {
    super('Drama survey database operation failed');
  }
}

export class DramaSurveyRepository {
  constructor(
    private readonly database?: DomainDb,
    private readonly readEnabled: () => Promise<boolean> = readDramaSurveyEnabled
  ) {}
  private get billing() {
    return this.database ?? getDomainDb('billing');
  }

  isEnabled() {
    return this.readEnabled();
  }

  async hasClaimed(userId: string): Promise<boolean> {
    const { data, error } = await this.billing
      .from('wallet_ledger')
      .select('id')
      .eq('user_id', userId)
      .eq('entry_type', 'survey_reward')
      .eq('reference_id', DRAMA_SURVEY_KEY)
      .limit(1)
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw new DramaSurveyError(error.code);
    return (data ?? []).length > 0;
  }

  async submit(userId: string, body: ParsedSubmitDramaSurveyRequest, rewardCredits: number) {
    const { data, error } = await this.billing
      .rpc('submit_drama_survey', {
        p_user_id: userId,
        p_survey_key: DRAMA_SURVEY_KEY,
        p_reward_credits: rewardCredits,
        p_open_reasons: body.open_reasons,
        p_open_other_text: body.open_other_text,
        p_watch_reasons: body.watch_reasons,
        p_watch_other_text: body.watch_other_text,
        p_comment: body.comment,
        p_platform: body.platform,
        p_engaged_dramas: body.engagement.engaged_dramas,
        p_max_episode: body.engagement.max_episode,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw new DramaSurveyError(error.code);
    const row = Array.isArray(data) ? data[0] : data;
    return SubmitDramaSurveyDataSchema.parse({
      status: row?.result_status,
      credits: row?.result_credits,
    });
  }

  /**
   * 叉掉只为算回答率和对比叉掉人群的观看深度；已提交的记录不会被覆盖。
   * miniapp_analytics 没有暴露给 PostgREST，和 free-zone 一样走直连 SQL。
   */
  async dismiss(userId: string, body: ParsedDismissDramaSurveyRequest) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
        await tx.$executeRaw`
          INSERT INTO miniapp_analytics.drama_survey_responses
            (survey_key, user_id, status, platform, engaged_dramas, max_episode)
          VALUES (${DRAMA_SURVEY_KEY}, ${userId}::uuid, 'dismissed', ${body.platform || null},
            ${body.engagement.engaged_dramas}, ${body.engagement.max_episode})
          ON CONFLICT (survey_key, user_id) DO NOTHING`;
      });
    } catch (err) {
      throw new DramaSurveyError(err instanceof Error && 'code' in err ? String(err.code) : 'db');
    }
  }
}

async function readDramaSurveyEnabled() {
  return (await fetchRuntimeConfigEntry(DRAMA_SURVEY_ENABLED_KEY))?.value === true;
}
