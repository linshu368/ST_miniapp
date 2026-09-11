/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-01 11:03:15
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-01 11:03:19
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
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
