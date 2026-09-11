/**
 * backend / features / voice / billing.ts
 *
 * 语音按次计费。**不是** features/generation 的一部分，也不共用它的计费口径：
 * 语音走 charge_voice_usage、按次定额、没有 finish_reason 闸门与免费额度两阶段。
 * 架构铁律 6 管的是聊天 LLM 的转发+扣费出口；语音链路的上游、任务性质与计费单位
 * 都不同（见 features/voice/voice-draft.ts 头注释），所以计费也留在本模块自己名下。
 *
 * 当前默认不扣费（`voice_billing_enabled` 默认 false，见 voice-billing-config.ts）。
 */
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';

let repository: MiniappWalletRepository | null = null;

function wallets(): MiniappWalletRepository {
  return (repository ??= new MiniappWalletRepository());
}

export async function precheckVoiceCredits(userId: string, requiredAmount: number) {
  const wallet = await wallets().getOrCreate(userId);
  const available = wallet.total_credits ?? wallet.main_credits + wallet.bonus_credits;
  return available < requiredAmount
    ? { ok: false as const, creditsRequired: requiredAmount, creditsAvailable: available }
    : { ok: true as const };
}

export async function settleVoiceGeneration(
  input: Parameters<MiniappWalletRepository['chargeVoiceUsage']>[0]
) {
  return wallets().chargeVoiceUsage(input);
}
