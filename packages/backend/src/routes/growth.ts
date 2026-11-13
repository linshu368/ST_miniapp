import { FastifyInstance, FastifyRequest } from 'fastify';
import {
  fail,
  ok,
  type RecordMiniappEntryData,
  type RecordMiniappEntryRequest,
} from '@miniapp/shared';
import { prisma } from '../lib/db.js';
import { getOrCreateMiniappUserByTgId } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';

const SOURCE_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

export default async function growthRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.post(
    '/api/growth/miniapp-entry',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      }

      const body = (request.body ?? {}) as Partial<RecordMiniappEntryRequest>;
      const sourceId = normalizeStartParam(
        body.source_id || body.start_param || readStartParam(request)
      );

      if (!sourceId) {
        return reply.send(ok<RecordMiniappEntryData>({ recorded: false, source_id: null }));
      }

      let trafficLink = null;
      try {
        trafficLink = await getTrafficBotlink(sourceId);
      } catch (e) {
        request.log.error(
          { event: 'growth.source_lookup_failed', err: e },
          'Traffic source lookup failed'
        );
      }

      if (!trafficLink) {
        return reply.send(ok<RecordMiniappEntryData>({ recorded: false, source_id: sourceId }));
      }

      // 传入 null 作为 sourceId，避免在创建用户时自动写入，从而可以在下面通过 UPDATE 的 affectedRows 判断是否为首次归因
      const dbUser = await getOrCreateMiniappUserByTgId(request.user.id.toString(), null, true);

      if (!dbUser.source_id) {
        const affectedRows = await prisma.$executeRawUnsafe(
          `UPDATE app_core.users SET source_id = $1, updated_at = now() WHERE id = $2::uuid AND source_id IS NULL`,
          sourceId,
          dbUser.id
        );

        if (affectedRows > 0) {
          // 仅在首次归因成功且属于新渠道表时，累加 miniapp_traffic.traffic_clicks
          await prisma.$executeRawUnsafe(`SELECT miniapp_traffic.increment_click($1)`, sourceId);
        }
      } else {
      }

      return reply.send(ok<RecordMiniappEntryData>({ recorded: true, source_id: sourceId }));
    }
  );
}

function normalizeStartParam(value: string | undefined): string | null {
  const normalized = value?.trim();

  if (!normalized || !SOURCE_ID_RE.test(normalized)) return null;
  return normalized;
}

function readStartParam(request: FastifyRequest): string | undefined {
  const initData = request.headers['x-init-data'];
  if (!initData || typeof initData !== 'string') return undefined;
  return new URLSearchParams(initData).get('start_param') ?? undefined;
}

async function getTrafficBotlink(sourceId: string) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM miniapp_traffic.botlinks WHERE source_id = $1 LIMIT 1`,
    sourceId
  );
  return rows[0] || null;
}
