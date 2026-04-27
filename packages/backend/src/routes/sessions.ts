import { FastifyInstance } from 'fastify';
import { Readable } from 'stream';
import { prisma } from '../lib/db.js';
import { ok, fail } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { channelRegistry } from '../ai/ChannelRegistry.js';
import { ModelTier, resolveChannelId } from '../ai/domain/ModelStrategy.js';
import type { OpenAIMessage } from '../ai/ports/IAIChannel.js';
import type {
  GetSessionsData,
  GetSessionDetailData,
  PostMessageRequest,
  PostMessageData,
  PostOpenSessionRequest,
  PostOpenSessionData,
  SessionSummary,
  Message,
} from '@miniapp/shared';

export default async function sessionRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/sessions', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const dbUser = await getOrCreateDbUser(request.user);

    const sessions = await prisma.appSession.findMany({
      where: { user_id: dbUser.id },
      orderBy: { last_message_at: 'desc' },
      include: {
        character: true,
        app_messages: {
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
          orderBy: { created_at: 'asc' },
        },
      },
    });

    if (!session) {
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
  app.post('/api/sessions/open', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const { character_id } = request.body as PostOpenSessionRequest;

    const dbUser = await getOrCreateDbUser(request.user);

    // Find existing session
    const existingSession = await prisma.appSession.findFirst({
      where: {
        user_id: dbUser.id,
        character_id: character_id,
      },
      orderBy: { last_message_at: 'desc' },
    });

    if (existingSession) {
      return reply.send(ok<PostOpenSessionData>({ session_id: existingSession.id }));
    }

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

  // @frontend-ready: false — 响应改 SSE 流，shared 契约 PostMessageData 待更新为流式格式
  app.post(
    '/api/sessions/:id/messages',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { id } = request.params as { id: string };
      const { content } = request.body as PostMessageRequest;

      const dbUser = await getOrCreateDbUser(request.user);

      // Verify ownership and get full session with character and history
      const session = await prisma.appSession.findUnique({
        where: { id },
        include: {
          character: true,
          app_messages: {
            orderBy: { created_at: 'asc' },
          },
        },
      });

      if (!session) {
        return reply.status(404).send(fail('NOT_FOUND', 'Session not found'));
      }

      if (session.user_id !== dbUser.id) {
        return reply.status(403).send(fail('FORBIDDEN', 'Access denied'));
      }

      const now = new Date();
      // 1. Save user message
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

      // 3. Get AI Channel
      const channelId = await resolveChannelId(ModelTier.FREE);
      const channel = await channelRegistry.getChannel(channelId);

      if (!channel) {
        return reply.status(500).send(fail('INTERNAL_ERROR', 'AI Channel not configured'));
      }

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
              yield `data: ${JSON.stringify({ error: 'Generation failed' })}\n\n`;
            }
          })()
        )
      );
    }
  );
}
