import { randomUUID } from 'node:crypto';
import { DEFAULT_FIRST_TOKEN_DEADLINE_MS } from '@miniapp/shared';
import type { ChatSessionRow } from '../../infrastructure/repositories/ChatSessionRepository.js';
import type { ConversationHistoryRepository } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import type { MiniappUserSettingsRepository } from '../../infrastructure/repositories/MiniappUserSettingsRepository.js';
import type { RequestLogger } from '../../lib/logger.js';
import { fetchModelCatalogSnapshot } from '../../platform/model-tiers.js';
import { fetchPlatformInstructions } from '../engine/index.js';
import { FirstTokenDeadlineError } from '../generation/first-token-fallback.js';
import { prepareGeneration, resolveModelForUser } from '../generation/index.js';
import { fetchContextWindowLimits } from './context-window.js';

/** Bound read-only preparation even if a dependency fails to honor its own timeout. */
export function withConversationPreparationDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function prepareConversationAdmission(
  user: Promise<{ id: string }>,
  readOwnedSession: (userId: string) => Promise<ChatSessionRow>,
  startedAt: number
) {
  let signal = AbortSignal.timeout(DEFAULT_FIRST_TOKEN_DEADLINE_MS);
  const sessionRead = user.then(({ id }) => {
    signal.throwIfAborted();
    return readOwnedSession(id);
  });
  // Ownership depends on identity alone. Handle rejection while the catalog is still pending.
  void sessionRead.catch(() => undefined);
  try {
    const [catalog] = await withConversationPreparationDeadline(
      Promise.all([fetchModelCatalogSnapshot(), user]),
      signal
    );
    const deadlineMs = catalog.catalog.first_token_deadline_ms ?? DEFAULT_FIRST_TOKEN_DEADLINE_MS;
    signal = AbortSignal.timeout(
      Math.max(1, Math.ceil(deadlineMs - (performance.now() - startedAt)))
    );
    const session = await withConversationPreparationDeadline(sessionRead, signal);
    signal.throwIfAborted();
    return { catalog, session, deadlineMs };
  } catch (error) {
    // A late identity must not start a session read after the route has failed.
    signal = AbortSignal.abort(error);
    throw error;
  }
}

/**
 * 开轮之前的只读准备：模型、用户设置、平台规则、上下文窗口并行读取，同时预热计费准备。
 *
 * 都放在写入之前：这里抛异常时会话还没被动过，不会留下没有回复的孤儿 user 行。
 * 准备期与首字共用路由入口开始的同一份预算，超时直接抛 FirstTokenDeadlineError。
 */
export async function prepareTurnInputs(input: {
  sessionId: string;
  characterId: string;
  userId: string;
  requestStartedAt: number;
  firstTokenDeadlineMs: number | undefined;
  catalogSnapshot: Awaited<ReturnType<typeof fetchModelCatalogSnapshot>> | undefined;
  settings: MiniappUserSettingsRepository;
  history: ConversationHistoryRepository;
  log: RequestLogger;
}) {
  const { userId, log } = input;
  // Server protection starts at route entry; only the browser can measure submit-to-display.
  const preparationRemainingMs =
    (input.firstTokenDeadlineMs ?? DEFAULT_FIRST_TOKEN_DEADLINE_MS) -
    (performance.now() - input.requestStartedAt);
  if (preparationRemainingMs <= 0) throw new FirstTokenDeadlineError();
  const preparationSignal = AbortSignal.timeout(Math.ceil(preparationRemainingMs));

  // 独立读取立即并行启动；用户偏好与模型选择复用同一份设置和规则快照。
  const instructionsPromise = fetchPlatformInstructions();
  const chargeId = randomUUID();
  const generationContextPromise = input.settings.getGenerationContext(userId, instructionsPromise);
  const modelPromise = resolveModelForUser(userId, {
    selectedModelId: generationContextPromise.then(({ config }) => config.selected_model_id),
    catalogSnapshot: input.catalogSnapshot,
  });
  // Read-only generation settings must not sit behind opening the turn and
  // reading its context. The same promise is consumed once by execute.
  const executionPreparation = prepareGeneration({
    model: modelPromise,
    characterId: input.characterId,
    useFallback: true,
    payer: { userId, chargeId, log, signal: preparationSignal },
  });
  void executionPreparation.catch(() => undefined);
  const [model, generationContext, instructions, windowLimits] =
    await withConversationPreparationDeadline(
      Promise.all([
        modelPromise,
        generationContextPromise,
        instructionsPromise,
        fetchContextWindowLimits(),
        // Ownership is already established. Recover stale writes concurrently
        // with independent reads, but always finish recovery before startTurn.
        input.history.recoverStaleStreaming(input.sessionId),
      ]),
      preparationSignal
    );

  if (instructions.degraded) {
    log.sys.error(
      { event: 'conversation.instructions.degraded', userId, sessionId: input.sessionId },
      'runtime_config 平台规则已降级到内置兜底，输出质量会明显下降'
    );
  }

  return {
    chargeId,
    model,
    userConfig: generationContext.config,
    displayName: generationContext.displayName,
    instructions,
    windowLimits,
    executionPreparation,
    preparationSignal,
  };
}
