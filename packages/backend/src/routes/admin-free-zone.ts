import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodError } from 'zod';
import {
  AdminFreeZoneDelistNowRequestSchema,
  AdminFreeZoneListNowRequestSchema,
  fail,
  ok,
} from '@miniapp/shared';
import { authorizeAdminOperator } from '../features/admin-access/session.js';
import { loadFreeZoneStatus } from '../features/free-zone/admin-status.js';
import { fetchFreeZoneConfig } from '../features/free-zone/config.js';
import { delistFreeZoneModelNow } from '../features/free-zone/manual-delist.js';
import { FreeZoneListNowError, listFreeZoneModelNow } from '../features/free-zone/manual-list.js';

function badParams(reply: FastifyReply, error: ZodError) {
  const issue = error.issues[0];
  return reply
    .status(400)
    .send(
      fail('BAD_REQUEST', `参数不合法：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`)
    );
}

const LIST_NOW_ERROR_CODES = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  502: 'UPSTREAM_UNAVAILABLE',
} as const;

/**
 * 运营平台畅聊：线上状态（只读，viewer 也能用）；手动上架、手动下架（写操作，只有 owner/operator）。
 */
export default async function adminFreeZoneRoutes(app: FastifyInstance) {
  app.get('/api/admin/free-zone/status', async (request, reply) => {
    if (!(await authorizeAdminOperator(request, reply, 'read'))) return reply;
    return reply.send(ok(await loadFreeZoneStatus(await fetchFreeZoneConfig())));
  });

  app.post('/api/admin/free-zone/list-now', async (request, reply) => {
    if (!(await authorizeAdminOperator(request, reply, 'write'))) return reply;
    const parsed = AdminFreeZoneListNowRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return badParams(reply, parsed.error);
    }
    try {
      const result = await listFreeZoneModelNow({
        candidateId: parsed.data.candidate_id,
        provider: parsed.data.provider,
      });
      request.log.info(
        { kind: 'biz', event: 'admin.free_zone.listed_manually', ...result },
        '运营手动上架畅聊模型'
      );
      return reply.send(ok(result));
    } catch (err) {
      if (!(err instanceof FreeZoneListNowError)) throw err;
      return reply
        .status(err.statusCode)
        .send(fail(LIST_NOW_ERROR_CODES[err.statusCode], err.message));
    }
  });

  app.post('/api/admin/free-zone/delist-now', async (request, reply) => {
    if (!(await authorizeAdminOperator(request, reply, 'write'))) return reply;
    const parsed = AdminFreeZoneDelistNowRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return badParams(reply, parsed.error);
    }
    try {
      const result = await delistFreeZoneModelNow({ candidateId: parsed.data.candidate_id });
      request.log.info(
        { kind: 'biz', event: 'admin.free_zone.delisted_manually', ...result },
        '运营手动下架畅聊模型'
      );
      return reply.send(ok(result));
    } catch (err) {
      if (!(err instanceof FreeZoneListNowError)) throw err;
      return reply
        .status(err.statusCode)
        .send(fail(LIST_NOW_ERROR_CODES[err.statusCode], err.message));
    }
  });
}
