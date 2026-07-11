import { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import type {
  GetUserSettingsData,
  PatchUserSettingsData,
  PatchUserSettingsRequest,
  SetUserAvatarData,
  SetUserAvatarRequest,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import {
  MiniappUserSettingsRepository,
  toUserSettings,
} from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { config } from '../platform/config.js';
import {
  decodeUploadedAvatar,
  deleteStoredUserAvatar,
  downloadRemoteAvatar,
  storeUserAvatar,
} from '../lib/user-avatar.js';

async function triggerAvatarProvision(userId: string): Promise<void> {
  const url = `${config.stProvisionUrl}/provision/${encodeURIComponent(userId)}?force=true&cards=none`;
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`头像已保存，但同步到聊天失败：${detail}`);
  }
}

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
        const patch = (request.body ?? {}) as PatchUserSettingsRequest;
        if ('avatar_url' in patch) {
          await deleteStoredUserAvatar(dbUser.id);
          await triggerAvatarProvision(dbUser.id);
        }

        return reply.send(ok<PatchUserSettingsData>({ settings: toUserSettings(row) }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Update settings failed';
        return reply.status(400).send(fail('BAD_REQUEST', message));
      }
    }
  );

  app.post(
    '/api/users/avatar',
    { preHandler: [requireTelegramAuth], bodyLimit: 3 * 1024 * 1024 },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      try {
        const body = (request.body ?? {}) as SetUserAvatarRequest;
        const image =
          body.source === 'upload'
            ? decodeUploadedAvatar(body.content_type, body.data_base64)
            : body.source === 'url'
              ? await downloadRemoteAvatar(body.url)
              : null;
        if (!image) throw new Error('头像导入方式无效');

        const dbUser = await getOrCreateDbUser(request.user);
        const publicUrl = await storeUserAvatar(dbUser.id, image);
        const row = await settings.setCustomAvatar(dbUser.id, request.user, publicUrl);
        await triggerAvatarProvision(dbUser.id);

        return reply.send(ok<SetUserAvatarData>({ settings: toUserSettings(row) }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Avatar import failed';
        return reply.status(400).send(fail('BAD_REQUEST', message));
      }
    }
  );
}
