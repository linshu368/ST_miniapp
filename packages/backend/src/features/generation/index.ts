/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-08-26 16:31:18
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-01 14:43:15
 * @Description:
 *  backend / features / generation / index.ts
 * 生成执行与计费出口（M3a）对 backend 内部的出口。
 * 自研对话链路走 resolveModelForUser + generationService.execute。
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */

export type {
  GenerationHooks,
  GenerationLogger,
  GenerationMessage,
  GenerationRequest,
  GenerationResult,
  GenerationService,
  GenerationStatus,
  ResolvedModel,
} from './types.js';

export {
  resolveAuthoritativeModel,
  resolveModelForUser,
  type AuthoritativeModel,
} from './resolve-model.js';

export {
  noFreeQuotaReservation,
  reserveCharacterFreeQuota,
  type FreeQuotaReservation,
} from './quota.js';

export {
  checkWalletBalance,
  resolveBillingPlan,
  type BalancePrecheck,
  type BillingPlan,
  type BillingSnapshot,
} from './precheck.js';

export {
  CHAT_COMPLETIONS_PATH,
  LLM_API_KEY,
  createSseTap,
  forwardToUpstream,
  resolveUpstreamUrl,
  type SseTap,
  type SseTapResult,
} from './upstream.js';

export {
  applyPromptCaching,
  isPromptCacheableModel,
  type PromptCacheTextBlock,
  type UpstreamMessage,
} from './prompt-caching.js';

export { execute, generationService } from './execute.js';
export { precheckVoiceCredits, settleVoiceGeneration } from './voice-billing.js';
