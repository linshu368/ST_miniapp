/**
 * backend / lib / invite-rewards.ts
 *
 * 裂变邀请发奖挂点。判定与账务全在 miniapp_traffic 的 SECURITY DEFINER RPC 里
 * （见 105/109 迁移），这里只负责调用与日志，不做任何余额加减。
 *
 * 本模块的函数一律不向外抛异常：奖励是附加收益，不能让它的失败变成主链路
 * （支付入账）的失败——那等于用户付了钱却拿不到自己充的星尘。
 */

import { getDomainDb } from './supabase.js';
import type { RequestLogger } from './logger.js';

/** 同时接受 requestLogger()（带 reqId，路由用）和 createLogger()（脚本用）。 */
type InviteRewardLogger = Pick<RequestLogger, 'biz' | 'sys'>;

interface InviteRewardRpcRow {
  status: string;
  credits: number;
}

/**
 * 被邀请人首次付费奖励：给这笔已入账订单跑一次判定，达标则给邀请人发星尘。
 *
 * 是否有邀请关系、这笔是否真的是首付、规则是否启用、单关系累计是否触顶，全部由
 * check_invite_first_paid_reward 裁决，调用方只需在入账成功后无条件调一次。
 */
export async function checkInviteFirstPaidReward(
  input: { userId: string; orderId: string },
  log: InviteRewardLogger
): Promise<void> {
  const { userId, orderId } = input;
  try {
    const { data, error } = await getDomainDb('miniapp_traffic').rpc(
      'check_invite_first_paid_reward',
      {
        p_invitee_user_id: userId,
        p_order_id: orderId,
      }
    );

    if (error) {
      log.sys.error(
        { event: 'payment.invite_reward.check_failed', err: error, userId, orderId },
        '邀请首付奖励判定失败'
      );
      return;
    }

    const row = (data as InviteRewardRpcRow[] | null)?.[0];
    if (row?.status === 'granted') {
      log.biz.info(
        {
          event: 'payment.invite_reward.granted',
          userId,
          orderId,
          credits: Number(row.credits),
        },
        '邀请首付奖励已发放'
      );
    }
  } catch (err) {
    log.sys.error(
      { event: 'payment.invite_reward.check_failed', err, userId, orderId },
      '邀请首付奖励判定异常'
    );
  }
}
