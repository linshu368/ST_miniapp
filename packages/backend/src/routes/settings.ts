import { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import type {
  GetUserSettingsData,
  PatchUserSettingsData,
  PatchUserSettingsRequest,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import {
  MiniappUserSettingsRepository,
  toUserSettings,
} from '../infrastructure/repositories/MiniappUserSettingsRepository.js';

export default async function settingsRoutes(app: FastifyInstance) {
  const settings = new MiniappUserSettingsRepository();

  // @frontend-ready: true
  app.get('/api/users/settings', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const dbUser = await getOrCreateDbUser(request.user);
    const row = await settings.getOrCreate(dbUser.id, request.user);

    return reply.send(ok<GetUserSettingsData>({ settings: toUserSettings(row) }));
  });

  // @frontend-ready: true
  app.patch(
    '/api/users/settings',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      try {
        const dbUser = await getOrCreateDbUser(request.user);
        const row = await settings.patch(
          dbUser.id,
          request.user,
          (request.body ?? {}) as PatchUserSettingsRequest
        );

        return reply.send(ok<PatchUserSettingsData>({ settings: toUserSettings(row) }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Update settings failed';
        return reply.status(400).send(fail('BAD_REQUEST', message));
      }
    }
  );
}
