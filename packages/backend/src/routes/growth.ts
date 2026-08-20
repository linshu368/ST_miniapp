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
  app.post(
    '/api/growth/miniapp-entry',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      console.log(`[Growth] miniapp-entry raw request body:`, request.body);
      console.log(`[Growth] miniapp-entry raw init data header:`, request.headers['x-init-data']);

      if (!request.user) {
        console.log(`[Growth] miniapp-entry UNAUTHORIZED`);
        return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      }

      const body = (request.body ?? {}) as Partial<RecordMiniappEntryRequest>;
      const sourceId = normalizeStartParam(
        body.source_id || body.start_param || readStartParam(request)
      );

      console.log(
        `[Growth] miniapp-entry called for user ${request.user.id}, sourceId: ${sourceId}, raw body:`,
        body
      );

      if (!sourceId) {
        console.log(`[Growth] miniapp-entry no sourceId, returning`);
        return reply.send(ok<RecordMiniappEntryData>({ recorded: false, source_id: null }));
      }

      let trafficLink = null;
      try {
        trafficLink = await getTrafficBotlink(sourceId);
      } catch (e) {
        console.error(`[Growth] Error fetching traffic botlink:`, e);
      }

      console.log(`[Growth] miniapp-entry trafficLink found:`, !!trafficLink);

      if (!trafficLink) {
        console.log(`[Growth] miniapp-entry trafficLink not found, returning`);
        return reply.send(ok<RecordMiniappEntryData>({ recorded: false, source_id: sourceId }));
      }

      // 传入 null 作为 sourceId，避免在创建用户时自动写入，从而可以在下面通过 UPDATE 的 affectedRows 判断是否为首次归因
      const dbUser = await getOrCreateMiniappUserByTgId(request.user.id.toString(), null, true);

      console.log(`[Growth] miniapp-entry dbUser.source_id:`, dbUser.source_id);

      if (!dbUser.source_id) {
        const affectedRows = await prisma.$executeRawUnsafe(
          `UPDATE miniapp.users SET source_id = $1, updated_at = now() WHERE id = $2::uuid AND source_id IS NULL`,
          sourceId,
          dbUser.id
        );

        console.log(`[Growth] miniapp-entry updated users affectedRows:`, affectedRows);

        if (affectedRows > 0) {
          // 仅在首次归因成功且属于新渠道表时，累加 miniapp_traffic.traffic_clicks
          await prisma.$executeRawUnsafe(`SELECT miniapp_traffic.increment_click($1)`, sourceId);
          console.log(`[Growth] miniapp-entry increment_click called for ${sourceId}`);
        }
      } else {
        console.log(
          `[Growth] miniapp-entry user already has source_id: ${dbUser.source_id}, skipping update`
        );
      }

      return reply.send(ok<RecordMiniappEntryData>({ recorded: true, source_id: sourceId }));
    }
  );
}

function normalizeStartParam(value: string | undefined): string | null {
  const normalized = value?.trim();
  console.log(
    `[Growth] normalizeStartParam input: '${value}', normalized: '${normalized}', matches RE: ${SOURCE_ID_RE.test(normalized || '')}`
  );
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
