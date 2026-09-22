import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CreateImageDescriptionRequestSchema,
  CreateMessageImageRequestSchema,
  fail,
  ok,
  type CreateImageDescriptionData,
  type CreateMessageImageData,
  type GetImageConfigData,
  type GetSessionImagesData,
  type ImageFailureKind,
  type ImageErrorCode,
  type ImageGenerationTier,
  type InsufficientBalanceErrorResponse,
  type MediaBillingMode,
  type MediaBillingPreview,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { config } from '../platform/config.js';
import {
  ChatSessionRepository,
  type ChatSessionRow,
} from '../infrastructure/repositories/ChatSessionRepository.js';
import {
  ConversationHistoryRepository,
  type ConversationHistoryRow,
} from '../infrastructure/repositories/ConversationHistoryRepository.js';
import {
  CharacterCardRepository,
  type CharacterCardRow,
} from '../infrastructure/repositories/CharacterCardRepository.js';
import { ConversationRepositoryError } from '../infrastructure/repositories/conversation-errors.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import {
  emptyFreeTrialQuota,
  FeatureFreeTrialRepository,
} from '../infrastructure/repositories/FeatureFreeTrialRepository.js';
import {
  ChatMessageImageRepository,
  ImageConflictError,
  toMessageImageAttempt,
} from '../infrastructure/repositories/ChatMessageImageRepository.js';
import {
  draftImageDescription,
  ImageUpstreamError,
  requireVisualAnchor,
} from '../features/generation/image-upstream.js';
import {
  emptyBasicImageFreeTrialQuota,
  getImageRuntimeConfig,
  getImageTierRuntimeConfig,
  toUserImageConfigData,
} from '../features/image/config.js';
import { VipStatusService } from '../features/vip/vip-status.js';
import {
  observeImageDescriptionCompleted,
  observeImageDescriptionFailed,
  observeImageGenerationAccepted,
} from '../features/image/ImageGenerationTelemetry.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PreparedMessageContext =
  | {
    ok: true;
    session: ChatSessionRow;
    turn: ConversationHistoryRow;
    character: CharacterCardRow;
  }
  | { ok: false; reply: (reply: FastifyReply) => unknown };

export default async function imageRoutes(app: FastifyInstance) {
  const sessions = new ChatSessionRepository();
  const history = new ConversationHistoryRepository();
  const characters = new CharacterCardRepository();
  const wallets = new MiniappWalletRepository();
  const images = new ChatMessageImageRepository();
  /** 免费体验仓库 */
  const freeTrials = new FeatureFreeTrialRepository();
  /** VIP 状态服务 */
  const vip = new VipStatusService();

  // @frontend-ready: true
  app.get(
    '/api/v1/images/config',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const dbUser = await getOrCreateDbUser(request.user);
      const imageConfig = await getImageRuntimeConfig();
      const basicFreeTrial = imageConfig.enabled
        ? await freeTrials.quota(dbUser.id, 'basic_image')
        : emptyBasicImageFreeTrialQuota();
      const vipStatus = await vip.getStatus(dbUser.id, requestLogger(request.log, 'image'));
      return reply.send(
        ok<GetImageConfigData>(
          toUserImageConfigData({ config: imageConfig, basicFreeTrial, vipStatus })
        )
      );
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/v1/conversations/:sessionId/images',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { sessionId } = request.params as { sessionId: string };
      if (!UUID_PATTERN.test(sessionId)) {
        return reply.status(400).send(fail('BAD_REQUEST', '会话 ID 无效'));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      try {
        await sessions.requireSession(sessionId, dbUser.id);
      } catch (error) {
        if (error instanceof ConversationRepositoryError) {
          return reply.status(404).send(fail('NOT_FOUND', '这段对话不存在'));
        }
        throw error;
      }
      return reply.send(
        ok<GetSessionImagesData>({ images: await images.listBySession(sessionId) })
      );
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/v1/conversations/:sessionId/messages/:messageId/image-description',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const log = requestLogger(request.log, 'image');
      const ids = readMessageRouteParams(request.params);
      if (!ids) return reply.status(400).send(fail('BAD_REQUEST', '这条内容不支持生成图片'));

      const imageConfig = await getImageRuntimeConfig();
      const unavailable = imageUnavailable(imageConfig);
      if (unavailable) return reply.status(503).send(fail('IMAGE_UNAVAILABLE', unavailable));
      /** 解析图片描述请求 */
      const parsed = CreateImageDescriptionRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send(fail('BAD_REQUEST', '图片档位格式不正确'));
      }
      /** 获取用户 */
      const dbUser = await getOrCreateDbUser(request.user);
      /** 获取 VIP 状态 */
      const vipStatus = await vip.getStatus(dbUser.id, log);
      /** 获取图片档位 */
      const tier = parsed.data.tier;
      /** 获取图片档位配置 */
      const tierConfig = getImageTierRuntimeConfig(imageConfig, tier);
      if (!tierConfig) {
        return reply.status(503).send(fail('IMAGE_ADVANCED_UNAVAILABLE', '图片档位暂不可用'));
      }
      if (tier === 'advanced' && !vipStatus.active) {
        return reply.status(403).send(fail('VIP_REQUIRED', '高级图片需要 VIP'));
      }
      /** 获取基础免费体验额度 */
      const basicFreeTrial =
        tier === 'basic'
          ? await freeTrials.quota(dbUser.id, 'basic_image')
          : emptyFreeTrialQuota('basic_image');
      /** 准备消息上下文 */
      const prepared = await prepareMessageContext(ids.sessionId, ids.messageId, dbUser.id);
      if (!prepared.ok) return prepared.reply(reply);

      let draftId: string | null = null;
      let draftAttemptNo: number | null = null;
      const startedAt = Date.now();
      try {
        const visualAnchor = requireVisualAnchor(prepared.character);
        const context = await history.getContextBeforeTurn(ids.sessionId, prepared.turn.turn_index);
        const promptCn = await draftImageDescription({
          character: prepared.character,
          visualAnchor,
          context,
          turn: prepared.turn,
          imageConfig,
          persistUserPrompt: async (userPrompt) => {
            const draft = await images.createDescriptionDraft({
              userId: dbUser.id,
              sessionId: ids.sessionId,
              messageId: ids.messageId,
              userPrompt,
              tier,
              provider: tierConfig.provider,
              model: tierConfig.model,
              baseUrlHost: tierConfig.baseUrlHost,
              width: tierConfig.width,
              height: tierConfig.height,
              priceCredits: tierConfig.creditsPerGeneration,
              priceLabel: tierConfig.priceLabel,
            });
            draftId = draft.id;
            draftAttemptNo = draft.attempt_no;
          },
        });
        if (!draftId) throw new Error('图片描述草稿未创建');
        await images.markDescriptionDraftReady(draftId, promptCn);
        if (draftAttemptNo !== null) {
          void observeImageDescriptionCompleted(
            {
              userId: dbUser.id,
              characterId: prepared.session.character_id,
              conversationSessionId: ids.sessionId,
              selectedModelId: prepared.turn.llm_billing_snapshot?.model_id ?? null,
              messageId: ids.messageId,
              attemptId: draftId,
              attemptNo: draftAttemptNo,
              promptChars: promptCn.length,
              durationMs: Date.now() - startedAt,
            },
            log
          );
        }
        log.biz.info(
          {
            event: 'image.description.done',
            messageId: ids.messageId,
            promptChars: promptCn.length,
          },
          '图片描述生成完成'
        );
        return reply.send(
          ok<CreateImageDescriptionData>({
            draft_id: draftId,
            prompt_cn: promptCn,
            tier,
            billing: buildImageBillingPreview({
              tier,
              billingMode:
                tier === 'basic' && basicFreeTrial.free_trials_remaining > 0
                  ? 'free_trial'
                  : 'paid',
              freeTrialOrdinal: tier === 'basic' ? basicFreeTrial.next_trial_ordinal : null,
              freeTrialsRemaining: tier === 'basic' ? basicFreeTrial.free_trials_remaining : null,
              freeTrialLimit: tier === 'basic' ? basicFreeTrial.free_trial_limit : null,
              priceCredits: tierConfig.creditsPerGeneration,
              priceLabel: tierConfig.priceLabel,
            }),
          })
        );
      } catch (error) {
        if (draftId) {
          try {
            /** 标记图片描述草稿失败 */
            await images.markDescriptionDraftFailed(
              draftId,
              error instanceof ImageUpstreamError
                ? (error.code as ImageErrorCode)
                : 'image_description_unusable'
            );
            /** 观察图片描述失败 */
            void observeImageDescriptionFailed(
              {
                userId: dbUser.id,
                characterId: prepared.session.character_id,
                conversationSessionId: ids.sessionId,
                selectedModelId: prepared.turn.llm_billing_snapshot?.model_id ?? null,
                messageId: ids.messageId,
                attemptId: draftId,
                ...(draftAttemptNo !== null ? { attemptNo: draftAttemptNo } : {}),
                errorCode:
                  error instanceof ImageUpstreamError ? error.code : 'image_description_unusable',
                durationMs: Date.now() - startedAt,
                failureKind: imageFailureKind(error),
              },
              log
            );
          } catch (markError) {
            log.sys.error(
              { event: 'image.description.mark_failed_error', draftId, err: markError },
              '标记图片描述草稿失败时再次出错'
            );
          }
        }
        log.sys.error(
          {
            event: 'image.description.failed',
            messageId: ids.messageId,
            errorCode:
              error instanceof ImageUpstreamError ? error.code : 'image_description_unusable',
            err: error,
          },
          '图片描述生成失败'
        );
        return reply
          .status(422)
          .send(fail('IMAGE_DESCRIPTION_FAILED', '这次没有写出合适的画面描述'));
      }
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/v1/conversations/:sessionId/messages/:messageId/image',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const log = requestLogger(request.log, 'image');
      const ids = readMessageRouteParams(request.params);
      if (!ids) return reply.status(400).send(fail('BAD_REQUEST', '这条内容不支持生成图片'));

      const imageConfig = await getImageRuntimeConfig();
      const unavailable = imageUnavailable(imageConfig);
      if (unavailable) return reply.status(503).send(fail('IMAGE_UNAVAILABLE', unavailable));

      const parsed = CreateMessageImageRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send(fail('BAD_REQUEST', '图片描述格式不正确'));
      }
      if (parsed.data.prompt_cn.length > imageConfig.maxPromptChars) {
        return reply.status(400).send(fail('BAD_REQUEST', imageConfig.promptOverLimitHint));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      const vipStatus = await vip.getStatus(dbUser.id, log);
      const tier = parsed.data.tier;
      const tierConfig = getImageTierRuntimeConfig(imageConfig, tier);
      if (!tierConfig) {
        return reply.status(503).send(fail('IMAGE_ADVANCED_UNAVAILABLE', '图片档位暂不可用'));
      }
      if (tier === 'advanced' && !vipStatus.active) {
        return reply.status(403).send(fail('VIP_REQUIRED', '高级图片需要 VIP'));
      }
      const prepared = await prepareMessageContext(ids.sessionId, ids.messageId, dbUser.id);
      if (!prepared.ok) return prepared.reply(reply);
      try {
        requireVisualAnchor(prepared.character);
      } catch {
        return reply
          .status(422)
          .send(fail('IMAGE_CHARACTER_UNAVAILABLE', '这个角色暂时缺少出图设定'));
      }

      const attemptId = parsed.data.draft_id ?? randomUUID();
      let billingMode: MediaBillingMode = 'paid';
      let freeTrialOrdinal: number | null = null;
      if (tier === 'basic') {
        const reservation = await freeTrials.reserve({
          userId: dbUser.id,
          feature: 'basic_image',
          referenceId: attemptId,
          ttlSeconds: config.image.workerLeaseSeconds + 900,
        });
        if (reservation.ok) {
          billingMode = 'free_trial';
          freeTrialOrdinal = reservation.fact.ordinal;
        } else if (reservation.code !== 'FEATURE_FREE_TRIAL_EXHAUSTED') {
          return reply.status(409).send(fail(reservation.code, reservation.message));
        }
      }
      if (billingMode === 'paid') {
        const precheck = await wallets.precheckMainCredits(
          dbUser.id,
          tierConfig.creditsPerGeneration
        );
        if (!precheck.ok) {
          const response: InsufficientBalanceErrorResponse = {
            error: {
              message: `Insufficient credits: have ${precheck.creditsAvailable}, need ${precheck.creditsRequired}`,
              type: 'insufficient_balance',
              credits_required: tierConfig.creditsPerGeneration,
              credits_available: precheck.creditsAvailable,
            },
          };
          return reply.status(402).send(response);
        }
      }

      try {
        const pending = parsed.data.draft_id
          ? await images.confirmDescriptionDraft({
            id: parsed.data.draft_id,
            userId: dbUser.id,
            sessionId: ids.sessionId,
            messageId: ids.messageId,
            tier,
            promptCn: parsed.data.prompt_cn,
            promptSource: parsed.data.prompt_source,
            provider: tierConfig.provider,
            model: tierConfig.model,
            baseUrlHost: tierConfig.baseUrlHost,
            width: tierConfig.width,
            height: tierConfig.height,
            priceCredits: tierConfig.creditsPerGeneration,
            priceLabel: tierConfig.priceLabel,
            billingMode,
            freeTrialOrdinal,
            walletPolicy: 'main_only',
            vipValidUntil: tier === 'advanced' ? vipStatus.valid_until : null,
          })
          : await images.createPending({
            id: attemptId,
            userId: dbUser.id,
            sessionId: ids.sessionId,
            messageId: ids.messageId,
            tier,
            promptCn: parsed.data.prompt_cn,
            promptSource: parsed.data.prompt_source,
            provider: tierConfig.provider,
            model: tierConfig.model,
            baseUrlHost: tierConfig.baseUrlHost,
            width: tierConfig.width,
            height: tierConfig.height,
            priceCredits: tierConfig.creditsPerGeneration,
            priceLabel: tierConfig.priceLabel,
            billingMode,
            freeTrialOrdinal,
            walletPolicy: 'main_only',
            vipValidUntil: tier === 'advanced' ? vipStatus.valid_until : null,
          });
        void observeImageGenerationAccepted(
          {
            userId: dbUser.id,
            characterId: prepared.session.character_id,
            conversationSessionId: ids.sessionId,
            selectedModelId: prepared.turn.llm_billing_snapshot?.model_id ?? null,
            messageId: ids.messageId,
            attemptId: pending.id,
            attemptNo: pending.attempt_no,
            promptSource: parsed.data.prompt_source,
            promptChars: parsed.data.prompt_cn.length,
            priceCredits: Number(pending.price_credits),
            width: pending.width,
            height: pending.height,
          },
          log
        );
        return reply
          .status(202)
          .send(ok<CreateMessageImageData>({ attempt: toMessageImageAttempt(pending) }));
      } catch (error) {
        if (billingMode === 'free_trial') {
          try {
            await freeTrials.release({
              userId: dbUser.id,
              feature: 'basic_image',
              referenceId: attemptId,
            });
          } catch (releaseError) {
            log.sys.error(
              { event: 'image.free_trial.release_failed', attemptId, err: releaseError },
              '释放图片免费体验名额失败'
            );
          }
        }
        if (error instanceof ImageConflictError) {
          return reply.status(409).send(fail('CONFLICT', '这条回复正在生成图片'));
        }
        throw error;
      }
    }
  );

  async function prepareMessageContext(
    sessionId: string,
    messageId: string,
    userId: string
  ): Promise<PreparedMessageContext> {
    let session;
    try {
      session = await sessions.requireSession(sessionId, userId);
    } catch (error) {
      if (error instanceof ConversationRepositoryError) {
        return {
          ok: false,
          reply: (reply: FastifyReply) =>
            reply.status(404).send(fail('NOT_FOUND', '这段对话不存在')),
        };
      }
      throw error;
    }

    const turn = await history.findCurrentTurnById(sessionId, messageId);
    if (!turn?.assistant_reply?.trim() || turn.status !== 'success') {
      return {
        ok: false,
        reply: (reply: FastifyReply) =>
          reply.status(404).send(fail('NOT_FOUND', '这条回复还不能生成图片')),
      };
    }
    return {
      ok: true,
      session,
      turn,
      character: await characters.requireCard(session.character_id),
    };
  }
}

/**
 * 读取消息路由参数
 * @param params 参数
 * @returns 消息路由参数
 */
function readMessageRouteParams(params: unknown): { sessionId: string; messageId: string } | null {
  const value = params as { sessionId?: unknown; messageId?: unknown };
  if (typeof value.sessionId !== 'string' || typeof value.messageId !== 'string') return null;
  if (!UUID_PATTERN.test(value.sessionId) || !UUID_PATTERN.test(value.messageId)) return null;
  return { sessionId: value.sessionId, messageId: value.messageId };
}

/**
 * 获取图片不可用原因
 * @param imageConfig 图片配置
 * @returns 图片不可用原因
 */
function imageUnavailable(
  imageConfig: Awaited<ReturnType<typeof getImageRuntimeConfig>>
): string | null {
  if (!imageConfig.enabled) return '图片生成功能暂未开放';
  if (!imageConfig.textModel.apiKey || !imageConfig.textModel.url || !imageConfig.textModel.model) {
    return '图片生成功能暂不可用';
  }
  return null;
}

/**
 * 获取图片失败类型
 * @param error 错误
 * @returns 图片失败类型
 */
function imageFailureKind(error: unknown): ImageFailureKind {
  if (!(error instanceof ImageUpstreamError)) return 'unknown';
  if (error.code.includes('timeout')) return 'timeout';
  if (error.code.includes('network')) return 'network';
  if (error.stage === 'download') return 'storage';
  if (error.stage === 'description') return 'provider';
  return 'provider';
}

/**
 * 构建图片计费预览
 * @param input 图片计费预览输入
 * @returns 图片计费预览
 */
function buildImageBillingPreview(input: {
  tier: ImageGenerationTier;
  billingMode: MediaBillingMode;
  freeTrialOrdinal: number | null;
  freeTrialsRemaining: number | null;
  freeTrialLimit: number | null;
  priceCredits: number;
  priceLabel: string;
}): MediaBillingPreview {
  return {
    billing_mode: input.billingMode,
    wallet_policy: 'main_only',
    price_credits: input.priceCredits,
    price_label: input.priceLabel,
    free_trial_limit: input.tier === 'basic' ? input.freeTrialLimit : null,
    free_trial_ordinal: input.tier === 'basic' ? input.freeTrialOrdinal : null,
    free_trials_remaining: input.tier === 'basic' ? input.freeTrialsRemaining : null,
  };
}
