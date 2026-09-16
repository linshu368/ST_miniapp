import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CreateMessageImageRequestSchema,
  fail,
  ok,
  type CreateImageDescriptionData,
  type CreateMessageImageData,
  type GetImageConfigData,
  type GetSessionImagesData,
  type ImageErrorCode,
  type InsufficientBalanceErrorResponse,
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
  ChatMessageImageRepository,
  ImageConflictError,
  toMessageImageAttempt,
} from '../infrastructure/repositories/ChatMessageImageRepository.js';
import {
  draftImageDescription,
  ImageUpstreamError,
  requireVisualAnchor,
} from '../features/generation/image-upstream.js';
import { getImageRuntimeConfig, toImageConfigData } from '../features/image/config.js';

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

  // @frontend-ready: true
  app.get(
    '/api/v1/images/config',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      return reply.send(ok<GetImageConfigData>(toImageConfigData(await getImageRuntimeConfig())));
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

      const dbUser = await getOrCreateDbUser(request.user);
      const prepared = await prepareMessageContext(ids.sessionId, ids.messageId, dbUser.id);
      if (!prepared.ok) return prepared.reply(reply);

      let draftId: string | null = null;
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
              model: config.image.grokModel,
              baseUrlHost: readUrlHost(config.image.liaobotsBase),
              width: imageConfig.width,
              height: imageConfig.height,
              priceCredits: imageConfig.creditsPerGeneration,
              priceLabel: imageConfig.priceLabel,
            });
            draftId = draft.id;
          },
        });
        if (!draftId) throw new Error('图片描述草稿未创建');
        await images.markDescriptionDraftReady(draftId, promptCn);
        log.biz.info(
          {
            event: 'image.description.done',
            messageId: ids.messageId,
            promptChars: promptCn.length,
          },
          '图片描述生成完成'
        );
        return reply.send(ok<CreateImageDescriptionData>({ draft_id: draftId, prompt_cn: promptCn }));
      } catch (error) {
        if (draftId) {
          try {
            await images.markDescriptionDraftFailed(
              draftId,
              error instanceof ImageUpstreamError
                ? (error.code as ImageErrorCode)
                : 'image_description_unusable'
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
      const prepared = await prepareMessageContext(ids.sessionId, ids.messageId, dbUser.id);
      if (!prepared.ok) return prepared.reply(reply);
      try {
        requireVisualAnchor(prepared.character);
      } catch {
        return reply
          .status(422)
          .send(fail('IMAGE_CHARACTER_UNAVAILABLE', '这个角色暂时缺少出图设定'));
      }

      const wallet = await wallets.getOrCreate(dbUser.id);
      const available = wallet.total_credits ?? wallet.main_credits + wallet.bonus_credits;
      if (available < imageConfig.creditsPerGeneration) {
        const response: InsufficientBalanceErrorResponse = {
          error: {
            message: `Insufficient credits: have ${available}, need ${imageConfig.creditsPerGeneration}`,
            type: 'insufficient_balance',
            credits_required: imageConfig.creditsPerGeneration,
            credits_available: available,
          },
        };
        return reply.status(402).send(response);
      }

      try {
        const pending = parsed.data.draft_id
          ? await images.confirmDescriptionDraft({
            id: parsed.data.draft_id,
            userId: dbUser.id,
            sessionId: ids.sessionId,
            messageId: ids.messageId,
            promptCn: parsed.data.prompt_cn,
            promptSource: parsed.data.prompt_source,
          })
          : await images.createPending({
            userId: dbUser.id,
            sessionId: ids.sessionId,
            messageId: ids.messageId,
            promptCn: parsed.data.prompt_cn,
            promptSource: parsed.data.prompt_source,
            model: config.image.grokModel,
            baseUrlHost: readUrlHost(config.image.liaobotsBase),
            width: imageConfig.width,
            height: imageConfig.height,
            priceCredits: imageConfig.creditsPerGeneration,
            priceLabel: imageConfig.priceLabel,
          });
        return reply
          .status(202)
          .send(ok<CreateMessageImageData>({ attempt: toMessageImageAttempt(pending) }));
      } catch (error) {
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

function readMessageRouteParams(params: unknown): { sessionId: string; messageId: string } | null {
  const value = params as { sessionId?: unknown; messageId?: unknown };
  if (typeof value.sessionId !== 'string' || typeof value.messageId !== 'string') return null;
  if (!UUID_PATTERN.test(value.sessionId) || !UUID_PATTERN.test(value.messageId)) return null;
  return { sessionId: value.sessionId, messageId: value.messageId };
}

function imageUnavailable(
  imageConfig: Awaited<ReturnType<typeof getImageRuntimeConfig>>
): string | null {
  if (!imageConfig.enabled) return '图片生成功能暂未开放';
  if (
    !imageConfig.textModel.apiKey ||
    !imageConfig.textModel.url ||
    !imageConfig.textModel.model ||
    !config.image.liaobotsAuth ||
    !config.image.grokModel
  ) {
    return '图片生成功能暂不可用';
  }
  return null;
}

function readUrlHost(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
