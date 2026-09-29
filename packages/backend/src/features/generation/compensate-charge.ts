/**
 * 文本「已扣后失败」的唯一补偿入口。
 *
 * 成功扣款之后，如果业务决定这一轮不能保留扣款，只能走这里。
 * 它调用 refund_llm_usage_charge，由数据库按原 debit 拆分入账。
 * 结算写 history 失败不要调用：sync 会按 charge_key 重放，不会二次扣款。
 */

import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import type { GenerationLogger } from './types.js';

let walletRepository: MiniappWalletRepository | null = null;

function wallets(): MiniappWalletRepository {
  return (walletRepository ??= new MiniappWalletRepository());
}

export async function compensateDebitedLlmCharge(input: {
  chargeId: string;
  reason: string;
  log: GenerationLogger;
}): Promise<'refunded' | 'already_refunded' | 'not_debited' | 'not_refundable'> {
  const started = Date.now();
  const result = await wallets().refundLlmUsageCharge({
    chargeId: input.chargeId,
    reason: input.reason,
  });
  input.log.biz.info(
    {
      event: 'llm.billing.compensate',
      chargeId: input.chargeId,
      status: result.status,
      durationMs: Date.now() - started,
    },
    'LLM 已扣费用原路退款补偿'
  );
  if (result.status === 'not_found') {
    throw new Error('LLM charge not found');
  }
  return result.status;
}
