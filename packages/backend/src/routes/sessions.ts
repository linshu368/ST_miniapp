import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { ok, fail } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
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

  app.post(
    '/api/sessions/:id/messages',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { id } = request.params as { id: string };
      const { content } = request.body as PostMessageRequest;

      const dbUser = await getOrCreateDbUser(request.user);

      // Verify ownership
      const session = await prisma.appSession.findUnique({
        where: { id },
      });

      if (!session) {
        return reply.status(404).send(fail('NOT_FOUND', 'Session not found'));
      }

      if (session.user_id !== dbUser.id) {
        return reply.status(403).send(fail('FORBIDDEN', 'Access denied'));
      }

      const now = new Date();
      const newMessage = await prisma.$transaction(async (tx) => {
        const msg = await tx.appMessage.create({
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

        return msg;
      });

      const message: Message = {
        id: newMessage.id,
        session_id: newMessage.session_id,
        role: newMessage.role as 'user' | 'assistant',
        content: newMessage.content,
        created_at: newMessage.created_at.toISOString(),
      };

      return reply.send(ok<PostMessageData>({ message }));
    }
  );
}
