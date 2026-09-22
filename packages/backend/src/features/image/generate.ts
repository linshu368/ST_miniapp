import type { Logger, RequestLogger } from '../../lib/logger.js';
import type { ImageErrorCode, ImageFailureKind } from '@miniapp/shared';
import { ChatMessageImageRepository } from '../../infrastructure/repositories/ChatMessageImageRepository.js';
import type { ChatMessageImageRow } from '../../infrastructure/repositories/ChatMessageImageRepository.js';
import { CharacterCardRepository } from '../../infrastructure/repositories/CharacterCardRepository.js';
import { ChatSessionRepository } from '../../infrastructure/repositories/ChatSessionRepository.js';
import { ConversationHistoryRepository } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import {
  deleteGeneratedMessageImage,
  storeGeneratedMessageImageBytes,
  storeGeneratedMessageImage,
} from '../../lib/chat-image-storage.js';
import { config } from '../../platform/config.js';
import type { ImageRuntimeConfig } from './config.js';
import {
  buildProviderPrompt,
  buildZProviderPrompt,
  generateGrokImage,
  generateZImage,
  type GeneratedProviderImage,
  ImageUpstreamError,
  requireVisualAnchor,
  translateImagePrompt,
} from '../generation/image-upstream.js';
import {
  observeImageGenerationCompleted,
  observeImageGenerationFailed,
} from './ImageGenerationTelemetry.js';

type ImageLogger = Logger | RequestLogger;

class ImageSettlementUnknownError extends Error {
  constructor(readonly cause: unknown) {
    super('图片结算结果未知');
    this.name = 'ImageSettlementUnknownError';
  }
}

/** 图片任务收口：翻译中文短文、调用 Grok、转存 Storage、成功后交给结算 RPC 原子扣费和置 current。 */
export async function runImageGeneration(input: {
  attempt: ChatMessageImageRow;
  imageConfig: ImageRuntimeConfig;
  log: ImageLogger;
}): Promise<void> {
  const images = new ChatMessageImageRepository();
  const sessions = new ChatSessionRepository();
  const history = new ConversationHistoryRepository();
  const characters = new CharacterCardRepository();
  const startedAt = Date.now();
  const attempt = input.attempt;
  let telemetryContext: { characterId: string; selectedModelId: string | null } | null = null;
  let terminalProvider = attempt.provider;

  try {
    const session = await sessions.getSession(attempt.session_id, attempt.user_id);
    if (!session) {
      await images.markFailed(attempt.id, 'image_session_not_found', Date.now() - startedAt);
      return;
    }
    telemetryContext = { characterId: session.character_id, selectedModelId: null };

    const turn = await history.findCurrentTurnById(attempt.session_id, attempt.message_id);
    if (!turn?.assistant_reply?.trim()) {
      const latencyMs = Date.now() - startedAt;
      await images.markFailed(attempt.id, 'image_message_not_eligible', latencyMs);
      void observeImageGenerationFailed(
        {
          ...imageTelemetryBase(attempt, telemetryContext),
          terminalStatus: 'failed',
          errorCode: 'image_message_not_eligible',
          failureKind: 'business',
          provider: attempt.provider,
          fallbackUsed: isFallbackProvider(attempt.provider),
          durationMs: latencyMs,
        },
        input.log
      );
      return;
    }
    telemetryContext = {
      characterId: session.character_id,
      selectedModelId: turn.llm_billing_snapshot?.model_id ?? null,
    };

    const character = await characters.requireCard(session.character_id);
    const visualAnchor = requireVisualAnchor(character);
    if (!attempt.prompt_cn) {
      const latencyMs = Date.now() - startedAt;
      await images.markFailed(attempt.id, 'image_prompt_empty', latencyMs);
      void observeImageGenerationFailed(
        {
          ...imageTelemetryBase(attempt, telemetryContext),
          terminalStatus: 'failed',
          errorCode: 'image_prompt_empty',
          failureKind: 'business',
          provider: attempt.provider,
          fallbackUsed: isFallbackProvider(attempt.provider),
          durationMs: latencyMs,
        },
        input.log
      );
      return;
    }
    const promptEn = await translateImagePrompt(attempt.prompt_cn, input.imageConfig.textModel);
    const providerPrompt =
      attempt.provider === 'replicate_z'
        ? buildZProviderPrompt({ visualAnchor, promptEn })
        : buildProviderPrompt({
            visualAnchor,
            promptEn,
            imageConfig: input.imageConfig,
          });
    // generating 是不可自动重领的 dispatch 边界；翻译失败或此前崩溃仍可由 leased 租约恢复。
    await images.markProviderDispatch(attempt.id, promptEn, providerPrompt);

    let providerImage: GeneratedProviderImage;
    try {
      providerImage =
        attempt.provider === 'replicate_z'
          ? await generateZImage({
              prompt: providerPrompt,
              width: attempt.width,
              height: attempt.height,
              model: attempt.model,
            })
          : await generateGrokImage({
              prompt: providerPrompt,
              width: attempt.width,
              height: attempt.height,
              model: attempt.model,
            });
      terminalProvider = providerImage.provider;
    } catch (grokError) {
      if (
        attempt.image_tier === 'advanced' ||
        attempt.provider !== 'liaobots_grok' ||
        !config.image.replicateToken ||
        !config.image.zModel
      ) {
        throw grokError;
      }
      terminalProvider = 'replicate_z';
      providerImage = await generateFallbackImage({
        attempt,
        images,
        visualAnchor,
        promptEn,
        grokError,
        log: input.log,
      });
    }

    await images.markStoring(attempt.id);
    let stored;
    try {
      stored = await storeProviderImage(providerImage, attempt, input.imageConfig.maxOutputBytes);
    } catch (grokOutputError) {
      // Grok 有时先返回临时 URL，真正下载时才以 HTTP/MIME/空响应表达内容拒绝。
      // 这仍属于主 provider 明确失败；Storage 上传异常则不能重复购买另一张图。
      if (
        providerImage.provider !== 'liaobots_grok' ||
        attempt.image_tier === 'advanced' ||
        !config.image.replicateToken ||
        !config.image.zModel ||
        !isGrokOutputFailure(grokOutputError)
      ) {
        throw grokOutputError;
      }
      terminalProvider = 'replicate_z';
      providerImage = await generateFallbackImage({
        attempt,
        images,
        visualAnchor,
        promptEn,
        grokError: grokOutputError,
        log: input.log,
      });
      await images.markStoring(attempt.id);
      stored = await storeProviderImage(providerImage, attempt, input.imageConfig.maxOutputBytes);
    }

    let settlement;
    try {
      settlement = await images.settleReady({
        attemptId: attempt.id,
        userId: attempt.user_id,
        amount: Number(attempt.price_credits),
        storagePath: stored.path,
        imageUrl: stored.url,
        mimeType: stored.mimeType,
        byteSize: stored.byteSize,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      // RPC 可能已提交但响应丢失；不能删除对象或覆盖 ready，只保留 storing 供人工/后续对账重放。
      throw new ImageSettlementUnknownError(error);
    }

    if (settlement.charge_status === 'insufficient_balance') {
      await compensateStoredImage(stored.path, attempt, input.log);
      void observeImageGenerationFailed(
        {
          ...imageTelemetryBase(attempt, telemetryContext),
          terminalStatus: 'failed',
          errorCode: 'image_settlement_insufficient_balance',
          failureKind: 'settlement',
          provider: providerImage.provider,
          fallbackUsed: isFallbackProvider(providerImage.provider),
          durationMs: Date.now() - startedAt,
        },
        input.log
      );
    } else if (settlement.charge_status === 'free_trial_invalid') {
      await compensateStoredImage(stored.path, attempt, input.log);
      void observeImageGenerationFailed(
        {
          ...imageTelemetryBase(attempt, telemetryContext),
          terminalStatus: 'failed',
          errorCode: 'image_free_trial_invalid',
          failureKind: 'settlement',
          provider: providerImage.provider,
          fallbackUsed: isFallbackProvider(providerImage.provider),
          durationMs: Date.now() - startedAt,
        },
        input.log
      );
    } else if (
      settlement.charge_status === 'charged' ||
      settlement.charge_status === 'already_charged' ||
      settlement.charge_status === 'free_trial_consumed' ||
      settlement.charge_status === 'already_free_trial_consumed'
    ) {
      const freeTrial =
        settlement.charge_status === 'free_trial_consumed' ||
        settlement.charge_status === 'already_free_trial_consumed';
      void observeImageGenerationCompleted(
        {
          ...imageTelemetryBase(attempt, telemetryContext),
          chargeStatus: settlement.charge_status,
          creditsCharged: freeTrial ? 0 : Number(attempt.price_credits),
          provider: providerImage.provider,
          fallbackUsed: isFallbackProvider(providerImage.provider),
          width: attempt.width,
          height: attempt.height,
          mimeType: stored.mimeType,
          byteSize: stored.byteSize,
          durationMs: Date.now() - startedAt,
        },
        input.log
      );
    }

    input.log.biz.info(
      {
        event: 'image.generate.done',
        attemptId: attempt.id,
        messageId: attempt.message_id,
        status: settlement.charge_status,
        byteSize: stored.byteSize,
        mimeType: stored.mimeType,
        latencyMs: Date.now() - startedAt,
      },
      '图片生成完成'
    );
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof ImageSettlementUnknownError) {
      input.log.sys.error(
        {
          event: 'image.settlement.unknown',
          attemptId: attempt.id,
          messageId: attempt.message_id,
          latencyMs,
          err: error.cause,
        },
        '图片结算响应未知，保留对象与状态等待幂等对账'
      );
      return;
    }
    const code: ImageErrorCode =
      error instanceof ImageUpstreamError
        ? (error.code as ImageErrorCode)
        : 'image_provider_failed';
    input.log.sys.error(
      {
        event: 'image.generate.failed',
        attemptId: attempt.id,
        messageId: attempt.message_id,
        stage: error instanceof ImageUpstreamError ? error.stage : null,
        errorCode: code,
        latencyMs,
        err: error,
      },
      '图片生成失败'
    );

    try {
      if (error instanceof ImageUpstreamError && error.unknownOutcome) {
        await images.markFailedUnknown(attempt.id, error.code as ImageErrorCode, latencyMs);
        if (telemetryContext) {
          void observeImageGenerationFailed(
            {
              ...imageTelemetryBase(attempt, telemetryContext),
              terminalStatus: 'failed_unknown',
              errorCode: error.code,
              failureKind: imageFailureKind(error),
              provider: terminalProvider,
              fallbackUsed: isFallbackProvider(terminalProvider),
              durationMs: latencyMs,
            },
            input.log
          );
        }
      } else {
        await images.markFailed(attempt.id, code, latencyMs);
        if (telemetryContext) {
          void observeImageGenerationFailed(
            {
              ...imageTelemetryBase(attempt, telemetryContext),
              terminalStatus: 'failed',
              errorCode: code,
              failureKind: imageFailureKind(error),
              provider: terminalProvider,
              fallbackUsed: isFallbackProvider(terminalProvider),
              durationMs: latencyMs,
            },
            input.log
          );
        }
      }
    } catch (markError) {
      input.log.sys.error(
        { event: 'image.generate.mark_failed_error', attemptId: attempt.id, err: markError },
        '标记图片生成失败时再次出错'
      );
    }
  }
}

async function generateFallbackImage(input: {
  attempt: ChatMessageImageRow;
  images: ChatMessageImageRepository;
  visualAnchor: string;
  promptEn: string;
  grokError: unknown;
  log: ImageLogger;
}): Promise<GeneratedProviderImage> {
  input.log.sys.warn(
    {
      event: 'image.provider.fallback',
      attemptId: input.attempt.id,
      fromProvider: 'liaobots_grok',
      toProvider: 'replicate_z',
      errorCode: input.grokError instanceof ImageUpstreamError ? input.grokError.code : 'unknown',
      err: input.grokError,
    },
    'Grok 生图失败，降级到 Z 模型'
  );
  await input.images.markProviderFallback({
    id: input.attempt.id,
    provider: 'replicate_z',
    model: config.image.zModel,
    baseUrlHost: readUrlHost(config.image.replicateBase),
  });
  const fallback = await generateZImage({
    prompt: buildZProviderPrompt({ visualAnchor: input.visualAnchor, promptEn: input.promptEn }),
    width: input.attempt.width,
    height: input.attempt.height,
  });
  await input.images.recordProviderRequestId(input.attempt.id, fallback.requestId);
  return fallback;
}

function storeProviderImage(
  image: GeneratedProviderImage,
  attempt: ChatMessageImageRow,
  maxBytes: number
) {
  return image.source === 'bytes'
    ? storeGeneratedMessageImageBytes({
        userId: attempt.user_id,
        messageId: attempt.message_id,
        attemptId: attempt.id,
        bytes: image.bytes,
        mimeType: image.mimeType,
        maxBytes,
      })
    : storeGeneratedMessageImage({
        userId: attempt.user_id,
        messageId: attempt.message_id,
        attemptId: attempt.id,
        sourceUrl: image.url,
        maxBytes,
      });
}

function isGrokOutputFailure(error: unknown): boolean {
  if (!(error instanceof ImageUpstreamError) || error.stage !== 'download') return false;
  return (
    error.code.startsWith('image_storage_download_') ||
    [
      'image_storage_mime_type',
      'image_storage_empty',
      'image_storage_size',
      'image_storage_url_rejected',
      'image_storage_redirect',
    ].includes(error.code)
  );
}

function readUrlHost(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function imageTelemetryBase(
  attempt: ChatMessageImageRow,
  context: { characterId: string; selectedModelId: string | null }
) {
  return {
    userId: attempt.user_id,
    characterId: context.characterId,
    conversationSessionId: attempt.session_id,
    selectedModelId: context.selectedModelId,
    messageId: attempt.message_id,
    attemptId: attempt.id,
    attemptNo: attempt.attempt_no,
  };
}

function isFallbackProvider(provider: string): boolean {
  return provider !== 'liaobots_grok';
}

function imageFailureKind(error: unknown): ImageFailureKind {
  if (!(error instanceof ImageUpstreamError)) return 'unknown';
  if (error.code.includes('timeout')) return 'timeout';
  if (error.code.includes('network')) return 'network';
  if (error.stage === 'download') return 'storage';
  if (error.stage === 'provider') return 'provider';
  return 'unknown';
}

/** 结算明确拒绝后删除不可展示对象；删除失败只告警，保留路径摘要供运维清理。 */
async function compensateStoredImage(
  storagePath: string,
  attempt: ChatMessageImageRow,
  log: ImageLogger
): Promise<void> {
  try {
    await deleteGeneratedMessageImage(storagePath);
  } catch (error) {
    log.sys.error(
      {
        event: 'image.storage.compensation_failed',
        attemptId: attempt.id,
        messageId: attempt.message_id,
        storagePath,
        err: error,
      },
      '图片结算拒绝后的对象清理失败'
    );
  }
}
