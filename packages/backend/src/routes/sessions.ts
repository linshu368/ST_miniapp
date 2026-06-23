import { FastifyInstance } from 'fastify';
import { Readable } from 'stream';
import { prisma } from '../lib/db.js';
import { ok, fail } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { channelRegistry } from '../ai/ChannelRegistry.js';
import { ModelTier, resolveChannelId } from '../ai/domain/ModelStrategy.js';
import { getChatMessageCreditCost } from '../features/chat/domain/billingRules.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import type { OpenAIMessage } from '../ai/ports/IAIChannel.js';
import type {
  GetSessionsData,
  GetSessionDetailData,
  PostMessageRequest,
  PostMessageData,
  PostOpenSessionRequest,
  PostOpenSessionData,
  PatchSessionRequest,
  PatchSessionData,
  DeleteSessionData,
  SessionSummary,
  Message,
} from '@miniapp/shared';

const REFUND_MAX_PARTIAL_REPLY_CHARS = 10;

export default async function sessionRoutes(app: FastifyInstance) {
  const wallets = new MiniappWalletRepository();

  // @frontend-ready: true
  app.get('/api/sessions', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const dbUser = await getOrCreateDbUser(request.user);

    const sessions = await prisma.appSession.findMany({
      where: { user_id: dbUser.id, is_deleted: false },
      orderBy: { last_message_at: 'desc' },
      include: {
        character: true,
        app_messages: {
          where: { is_deleted: false },
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
    });

    const sessionsSummary: SessionSummary[] = sessions.map((s) => {
      const lastMessage = s.app_messages[0];
      return {
        id: s.id,
        character_id: s.character_id || '',
        character_name: s.character?.name || 'Unknown',
        last_message_preview: lastMessage ? lastMessage.content : '',
        last_message_at: s.last_message_at.toISOString(),
        is_pinned: s.is_pinned,
        custom_name: s.custom_name || undefined,
      };
    });

    return reply.send(ok<GetSessionsData>({ sessions: sessionsSummary }));
  });

  // @frontend-ready: true
  app.get('/api/sessions/:id', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const { id } = request.params as { id: string };

    const dbUser = await getOrCreateDbUser(request.user);

    const session = await prisma.appSession.findUnique({
      where: { id },
      include: {
        app_messages: {
          where: { is_deleted: false },
          orderBy: { created_at: 'asc' },
        },
      },
    });

    if (!session || session.is_deleted) {
      return reply.status(404).send(fail('NOT_FOUND', 'Session not found'));
    }

    if (session.user_id !== dbUser.id) {
      return reply.status(403).send(fail('FORBIDDEN', 'Access denied'));
    }

    const messages: Message[] = session.app_messages.map((m) => ({
      id: m.id,
      session_id: m.session_id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      created_at: m.created_at.toISOString(),
    }));

    return reply.send(
      ok<GetSessionDetailData>({
        session: {
          id: session.id,
          character_id: session.character_id || '',
          messages,
        },
      })
    );
  });

  // @frontend-ready: true
  app.patch('/api/sessions/:id', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const { id } = request.params as { id: string };
    const { custom_name, is_pinned } = request.body as PatchSessionRequest;

    const dbUser = await getOrCreateDbUser(request.user);

    const session = await prisma.appSession.findUnique({
      where: { id },
    });

    if (!session || session.is_deleted) {
      return reply.status(404).send(fail('NOT_FOUND', 'Session not found'));
    }

    if (session.user_id !== dbUser.id) {
      return reply.status(403).send(fail('FORBIDDEN', 'Access denied'));
    }

    const updateData: any = {};
    if (is_pinned !== undefined) {
      updateData.is_pinned = is_pinned;
    }
    if (custom_name !== undefined) {
      updateData.custom_name = custom_name === '' ? null : custom_name;
    }

    const updatedSession = await prisma.appSession.update({
      where: { id },
      data: updateData,
      include: {
        character: true,
        app_messages: {
          where: { is_deleted: false },
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
    });

    const lastMessage = updatedSession.app_messages[0];
    const summary: SessionSummary = {
      id: updatedSession.id,
      character_id: updatedSession.character_id || '',
      character_name: updatedSession.character?.name || 'Unknown',
      last_message_preview: lastMessage ? lastMessage.content : '',
      last_message_at: updatedSession.last_message_at.toISOString(),
      is_pinned: updatedSession.is_pinned,
      custom_name: updatedSession.custom_name || undefined,
    };

    return reply.send(ok<PatchSessionData>({ session: summary }));
  });

  // @frontend-ready: true
  app.delete('/api/sessions/:id', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const { id } = request.params as { id: string };

    const dbUser = await getOrCreateDbUser(request.user);

    const session = await prisma.appSession.findUnique({
      where: { id },
    });

    if (!session || session.is_deleted) {
      return reply.status(404).send(fail('NOT_FOUND', 'Session not found'));
    }

    if (session.user_id !== dbUser.id) {
      return reply.status(403).send(fail('FORBIDDEN', 'Access denied'));
    }

    await prisma.$transaction(async (tx) => {
      await tx.appSession.update({
        where: { id },
        data: { is_deleted: true },
      });
      await tx.appMessage.updateMany({
        where: { session_id: id },
        data: { is_deleted: true },
      });
    });

    return reply.send(ok<DeleteSessionData>({ session_id: id }));
  });

  // @frontend-ready: true
  app.post('/api/sessions/open', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const { character_id } = request.body as PostOpenSessionRequest;

    const dbUser = await getOrCreateDbUser(request.user);

    // Find character to get greeting
    const character = await prisma.character.findUnique({
      where: { id: character_id },
    });

    if (!character) {
      return reply.status(404).send(fail('NOT_FOUND', 'Character not found'));
    }

    // Create new session and initial greeting message
    const newSession = await prisma.$transaction(async (tx) => {
      const session = await tx.appSession.create({
        data: {
          user_id: dbUser.id,
          character_id: character_id,
          last_message_at: new Date(),
        },
      });

      await tx.appMessage.create({
        data: {
          session_id: session.id,
          role: 'assistant',
          content: character.first_mes,
        },
      });

      return session;
    });

    return reply.send(ok<PostOpenSessionData>({ session_id: newSession.id }));
  });

  // @frontend-ready: true
  app.post(
    '/api/sessions/:id/messages',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { id } = request.params as { id: string };
      const { content, client_message_id } = request.body as PostMessageRequest;
      const clientMessageId = normalizeClientMessageId(client_message_id);

      const dbUser = await getOrCreateDbUser(request.user);

      // Verify ownership and get full session with character and history
      const session = await prisma.appSession.findUnique({
        where: { id },
        include: {
          character: true,
          app_messages: {
            where: { is_deleted: false },
            orderBy: { created_at: 'asc' },
          },
        },
      });

      if (!session || session.is_deleted) {
        return reply.status(404).send(fail('NOT_FOUND', 'Session not found'));
      }

      if (session.user_id !== dbUser.id) {
        return reply.status(403).send(fail('FORBIDDEN', 'Access denied'));
      }

      // Get AI Channel before charging; missing channel should never consume credits.
      const channelId = await resolveChannelId(ModelTier.TIER_1);
      const channel = await channelRegistry.getChannel(channelId);

      if (!channel) {
        return reply.status(500).send(fail('INTERNAL_ERROR', 'AI Channel not configured'));
      }

      let charged = false;
      const messageCreditCost = await getChatMessageCreditCost();
      try {
        const result = await wallets.chargeChatMessage({
          userId: dbUser.id,
          sessionId: id,
          clientMessageId,
          amount: messageCreditCost,
        });
        if (result.alreadyCharged) {
          return reply.status(409).send(fail('DUPLICATE_MESSAGE', '消息已处理，请勿重复发送'));
        }
        // cost=0 is a free-chat mode, but the RPC still reserves client_message_id for idempotency.
        charged = true;
      } catch (error) {
        request.log.warn(
          { err: error, userId: dbUser.id, cost: messageCreditCost },
          'MiniApp wallet credits insufficient'
        );
        return reply.status(402).send(fail('INSUFFICIENT_CREDITS', '星尘余额不足，请先充值'));
      }

      const now = new Date();
      // 1. Save user message
      try {
        await prisma.$transaction(async (tx) => {
          await tx.appMessage.create({
            data: {
              session_id: id,
              role: 'user',
              content: content,
              created_at: now,
            },
          });

          await tx.appSession.update({
            where: { id },
            data: { last_message_at: now },
          });
        });
      } catch (error) {
        if (charged) {
          await refundChatChargeSafely(
            wallets,
            dbUser.id,
            id,
            clientMessageId,
            'message_persist_failed',
            request.log
          );
        }
        throw error;
      }

      // 2. Prepare messages for AI
      const aiMessages: OpenAIMessage[] = [];

      // Build system prompt from character data
      if (session.character) {
        const systemParts = [
          session.character.description,
          session.character.personality,
          session.character.scenario,
          session.character.system_prompt,
        ].filter(Boolean);

        if (systemParts.length > 0) {
          aiMessages.push({ role: 'system', content: systemParts.join('\n\n') });
        }
      }

      // Add history
      for (const msg of session.app_messages) {
        aiMessages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
      // Add current user message
      aiMessages.push({ role: 'user', content: content });

      // 4. Setup SSE response
      reply.header('Content-Type', 'text/event-stream');
      reply.header('Cache-Control', 'no-cache');
      reply.header('Connection', 'keep-alive');

      // Return an async generator to stream the response
      return reply.send(
        Readable.from(
          (async function* () {
            let fullAssistantReply = '';
            try {
              const stream = channel.streamGenerate(aiMessages);
              for await (const chunk of stream) {
                fullAssistantReply += chunk;
                // Send chunk to client
                yield `data: ${JSON.stringify({ content: chunk })}\n\n`;
              }

              // Stream finished
              yield 'data: [DONE]\n\n';

              // Save assistant message to DB
              if (fullAssistantReply) {
                await prisma.appMessage.create({
                  data: {
                    session_id: id,
                    role: 'assistant',
                    content: fullAssistantReply,
                  },
                });
              }
            } catch (error) {
              console.error('AI Stream Error:', error);
              const deliveredChars = fullAssistantReply.trim().length;
              if (charged && deliveredChars <= REFUND_MAX_PARTIAL_REPLY_CHARS) {
                await refundChatChargeSafely(
                  wallets,
                  dbUser.id,
                  id,
                  clientMessageId,
                  'ai_generation_failed',
                  request.log
                );
              } else if (charged) {
                request.log.warn(
                  { sessionId: id, clientMessageId, deliveredChars },
                  'Skip refund because assistant reply was partially delivered'
                );
              }
              yield `data: ${JSON.stringify({ error: 'Generation failed' })}\n\n`;
            }
          })()
        )
      );
    }
  );
}

function normalizeClientMessageId(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim().slice(0, 128);
  }
  return `server-msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function refundChatChargeSafely(
  wallets: MiniappWalletRepository,
  userId: string,
  sessionId: string,
  clientMessageId: string,
  reason: string,
  log: { warn: (obj: unknown, msg: string) => void }
) {
  try {
    await wallets.refundChatMessage({
      userId,
      sessionId,
      clientMessageId,
      reason,
    });
  } catch (error) {
    log.warn(
      { err: error, userId, sessionId, clientMessageId, reason },
      'Refund chat charge failed'
    );
  }
}
