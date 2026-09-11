/**
 * backend / features / generation / index.ts
 *
 * 生成执行与计费出口对 backend 内部的唯一入口（架构铁律 6）。
 * 对话链路走 resolveModelForUser + execute；LLM 计费的两条结算路径
 * （即时 settle 与回捞 sync-job）也都在本模块内，别处不要另起。
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
export { settleGeneration, type GenerationSettlementEntry } from './settle.js';
export { startChatHistorySyncJob, stopChatHistorySyncJob } from './sync-job.js';
