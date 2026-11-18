/**
 * backend / routes / character-persona.ts
 *
 * GET    /api/characters/:characterId/my-settings — 这张卡上的补充设定、人设选择，以及人设库
 * PUT    /api/characters/:characterId/my-settings — 部分更新补充设定 / 人设选择
 * POST   /api/personas                            — 新建主角人设
 * PATCH  /api/personas/:personaId                 — 保存主角人设（整对象）
 * DELETE /api/personas/:personaId                 — 删除主角人设
 *
 * 设定从下一轮对话起生效，由生成链路每轮重新读取并注入，不属于历史，不会被截断或压缩冲掉。
 */

import { FastifyInstance } from 'fastify';
import {
  fail,
  ok,
  PutCharacterMySettingsRequestSchema,
  SavePersonaRequestSchema,
  type DeletePersonaData,
  type GetCharacterMySettingsData,
  type SavePersonaData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import {
  PersonaRepositoryError,
  UserPersonaRepository,
} from '../infrastructure/repositories/UserPersonaRepository.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REPOSITORY_ERRORS = {
  PERSONA_LIMIT: { status: 409, message: '人设最多 10 个，请先删除一个' },
  PERSONA_NOT_FOUND: { status: 404, message: '这个人设不存在' },
  CHARACTER_NOT_FOUND: { status: 404, message: '角色不存在' },
} as const;

export default async function characterPersonaRoutes(app: FastifyInstance) {
  const repo = new UserPersonaRepository();

  app.get(
    '/api/characters/:characterId/my-settings',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { characterId } = request.params as { characterId: string };
      if (!UUID_REGEX.test(characterId)) {
        return reply.status(400).send(fail('INVALID_CHARACTER_ID', 'Invalid character id'));
      }
      const log = requestLogger(request.log, 'character-persona');
      try {
        const dbUser = await getOrCreateDbUser(request.user);
        const [settings, personas] = await Promise.all([
          repo.readMySettings(dbUser.id, characterId),
          repo.listPersonas(dbUser.id),
        ]);
        return reply.send(
          ok<GetCharacterMySettingsData>({
            notes: settings.notes,
            persona: settings.persona,
            personas,
          })
        );
      } catch (err) {
        log.sys.error({ event: 'character_persona.read.failed', err }, 'my-settings read failed');
        return reply.status(500).send(fail('INTERNAL_ERROR', '角色设定读取失败'));
      }
    }
  );

  app.put(
    '/api/characters/:characterId/my-settings',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { characterId } = request.params as { characterId: string };
      if (!UUID_REGEX.test(characterId)) {
        return reply.status(400).send(fail('INVALID_CHARACTER_ID', 'Invalid character id'));
      }
      const parsed = PutCharacterMySettingsRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send(fail('INVALID_REQUEST', '设定内容不符合要求'));
      }
      const log = requestLogger(request.log, 'character-persona');
      try {
        const dbUser = await getOrCreateDbUser(request.user);
        await repo.writeMySettings(dbUser.id, characterId, parsed.data);
        const [settings, personas] = await Promise.all([
          repo.readMySettings(dbUser.id, characterId),
          repo.listPersonas(dbUser.id),
        ]);
        // 日志只记长度与选择模式，不记设定正文。
        log.biz.info(
          {
            event: 'character_persona.saved',
            characterId,
            notesLength: parsed.data.notes?.length,
            personaMode: parsed.data.persona?.mode,
          },
          '角色设定已保存'
        );
        return reply.send(
          ok<GetCharacterMySettingsData>({
            notes: settings.notes,
            persona: settings.persona,
            personas,
          })
        );
      } catch (err) {
        if (err instanceof PersonaRepositoryError) {
          const mapped = REPOSITORY_ERRORS[err.code];
          return reply.status(mapped.status).send(fail(err.code, mapped.message));
        }
        log.sys.error({ event: 'character_persona.write.failed', err }, 'my-settings write failed');
        return reply.status(500).send(fail('INTERNAL_ERROR', '角色设定保存失败'));
      }
    }
  );

  app.post('/api/personas', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const parsed = SavePersonaRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply.status(400).send(fail('INVALID_REQUEST', '人设内容不符合要求'));
    return savePersona(request, reply, null, parsed.data);
  });

  app.patch(
    '/api/personas/:personaId',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { personaId } = request.params as { personaId: string };
      if (!UUID_REGEX.test(personaId)) {
        return reply.status(400).send(fail('INVALID_PERSONA_ID', 'Invalid persona id'));
      }
      const parsed = SavePersonaRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send(fail('INVALID_REQUEST', '人设内容不符合要求'));
      }
      return savePersona(request, reply, personaId, parsed.data);
    }
  );

  app.delete(
    '/api/personas/:personaId',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { personaId } = request.params as { personaId: string };
      if (!UUID_REGEX.test(personaId)) {
        return reply.status(400).send(fail('INVALID_PERSONA_ID', 'Invalid persona id'));
      }
      const log = requestLogger(request.log, 'character-persona');
      try {
        const dbUser = await getOrCreateDbUser(request.user);
        const deleted = await repo.deletePersona(dbUser.id, personaId);
        return reply.send(ok<DeletePersonaData>({ deleted }));
      } catch (err) {
        log.sys.error({ event: 'character_persona.delete.failed', err }, 'persona delete failed');
        return reply.status(500).send(fail('INTERNAL_ERROR', '人设删除失败'));
      }
    }
  );

  async function savePersona(
    request: Parameters<typeof requireTelegramAuth>[0],
    reply: Parameters<typeof requireTelegramAuth>[1],
    personaId: string | null,
    body: Parameters<UserPersonaRepository['savePersona']>[2]
  ) {
    const log = requestLogger(request.log, 'character-persona');
    try {
      const dbUser = await getOrCreateDbUser(request.user!);
      const persona = await repo.savePersona(dbUser.id, personaId, body);
      return reply.send(ok<SavePersonaData>({ persona }));
    } catch (err) {
      if (err instanceof PersonaRepositoryError) {
        const mapped = REPOSITORY_ERRORS[err.code];
        return reply.status(mapped.status).send(fail(err.code, mapped.message));
      }
      log.sys.error({ event: 'character_persona.save.failed', err }, 'persona save failed');
      return reply.status(500).send(fail('INTERNAL_ERROR', '人设保存失败'));
    }
  }
}
