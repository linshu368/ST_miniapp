import type { Logger, RequestLogger } from '../../lib/logger.js';
import type { ImageErrorCode } from '@miniapp/shared';
import { ChatMessageImageRepository } from '../../infrastructure/repositories/ChatMessageImageRepository.js';
import type { ChatMessageImageRow } from '../../infrastructure/repositories/ChatMessageImageRepository.js';
import { CharacterCardRepository } from '../../infrastructure/repositories/CharacterCardRepository.js';
import { ChatSessionRepository } from '../../infrastructure/repositories/ChatSessionRepository.js';
import { ConversationHistoryRepository } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { storeGeneratedMessageImage } from '../../lib/chat-image-storage.js';
import type { ImageRuntimeConfig } from './config.js';
import {
  buildProviderPrompt,
  generateGrokImage,
  ImageUpstreamError,
  requireVisualAnchor,
  translateImagePrompt,
} from './upstream.js';

type ImageLogger = Logger | RequestLogger;

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

  try {
    await images.markGenerating(attempt.id);

    const session = await sessions.getSession(attempt.session_id, attempt.user_id);
    if (!session) {
      await images.markFailed(attempt.id, 'image_session_not_found', Date.now() - startedAt);
      return;
    }

    const turn = await history.findCurrentTurnById(attempt.session_id, attempt.message_id);
    if (!turn?.assistant_reply?.trim()) {
      await images.markFailed(attempt.id, 'image_message_not_eligible', Date.now() - startedAt);
      return;
    }

    const character = await characters.requireCard(session.character_id);
    const visualAnchor = requireVisualAnchor(character);
    const promptEn = await translateImagePrompt(attempt.prompt_cn);
    const providerPrompt = buildProviderPrompt({
      visualAnchor,
      promptEn,
      imageConfig: input.imageConfig,
    });
    await images.savePrompts(attempt.id, promptEn, providerPrompt);

    const providerUrl = await generateGrokImage({
      prompt: providerPrompt,
      width: attempt.width,
      height: attempt.height,
    });

    await images.markStoring(attempt.id);
    const stored = await storeGeneratedMessageImage({
      userId: attempt.user_id,
      messageId: attempt.message_id,
      attemptId: attempt.id,
      sourceUrl: providerUrl,
      maxBytes: input.imageConfig.maxOutputBytes,
    });

    const settlement = await images.settleReady({
      attemptId: attempt.id,
      userId: attempt.user_id,
      amount: Number(attempt.price_credits),
      storagePath: stored.path,
      imageUrl: stored.url,
      mimeType: stored.mimeType,
      byteSize: stored.byteSize,
      latencyMs: Date.now() - startedAt,
    });

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
        await images.markFailedUnknown(attempt.id, 'image_provider_timeout_unknown', latencyMs);
      } else {
        await images.markFailed(attempt.id, code, latencyMs);
      }
    } catch (markError) {
      input.log.sys.error(
        { event: 'image.generate.mark_failed_error', attemptId: attempt.id, err: markError },
        '标记图片生成失败时再次出错'
      );
    }
  }
}
