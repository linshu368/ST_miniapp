import { randomBytes, createHash } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  fail,
  ok,
  type CreateGrowthChannelLinkData,
  type CreateGrowthChannelLinkRequest,
  type GetGrowthChannelLinksData,
  type GrowthChannelLinkData,
  type RecordMiniappEntryData,
  type RecordMiniappEntryRequest,
} from '@miniapp/shared';
import { config } from '../platform/config.js';
import { prisma } from '../lib/db.js';
import { getOrCreateMiniappUserByTgId } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';

const ADMIN_HEADER = 'x-cs-admin-token';
const OPERATOR_HEADER = 'x-cs-operator-id';
const SOURCE_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

interface GrowthRequest extends FastifyRequest {
  csOperatorId?: string;
}

export default async function growthRoutes(app: FastifyInstance) {
  app.get(
    '/api/cs/growth/channel-links',
    { preHandler: [requireCsAdmin] },
    async (_request, reply) => {
      const links = await listChannelLinks();
      return reply.send(ok<GetGrowthChannelLinksData>({ links }));
    }
  );

  app.post(
    '/api/cs/growth/channel-links',
    { preHandler: [requireCsAdmin] },
    async (request: GrowthRequest, reply) => {
      const body = (request.body ?? {}) as Partial<CreateGrowthChannelLinkRequest>;
      const sourceName = body.source_name?.trim();
      if (!sourceName) {
        return reply.status(400).send(fail('INVALID_SOURCE_NAME', '渠道名称不能为空'));
      }

      const sourceId = (body.source_id?.trim() || (await generateSourceId())).replace(/\s+/g, '_');
      if (!SOURCE_ID_RE.test(sourceId)) {
        return reply
          .status(400)
          .send(fail('INVALID_SOURCE_ID', '渠道暗参只能包含字母、数字、下划线和短横线，长度 3-64'));
      }

      const miniappLink = buildMiniappLink(sourceId);
      const trackingLink = buildTrackingLink(request, sourceId);

      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO growth.channel_links (source_name, source_id, miniapp_link, tracking_link, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          sourceName,
          sourceId,
          miniappLink,
          trackingLink,
          body.notes?.trim() ?? '',
          getOperator(request)
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '创建渠道链接失败';
        if (message.includes('Unique constraint') || message.includes('duplicate key')) {
          return reply.status(409).send(fail('SOURCE_ID_EXISTS', '渠道暗参已存在'));
        }
        throw error;
      }

      const link = (await listChannelLinks()).find((item) => item.source_id === sourceId);
      if (!link)
        return reply.status(500).send(fail('CREATE_LINK_FAILED', '创建后读取渠道链接失败'));
      return reply.status(201).send(ok<CreateGrowthChannelLinkData>({ link }));
    }
  );

  app.get('/api/growth/click/:sourceId', async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    const link = await getChannelLink(sourceId);
    if (!link || link.status !== 'active') {
      return reply.status(404).send(fail('SOURCE_NOT_FOUND', '渠道链接不存在'));
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO growth.link_clicks (source_id, ip_hash, user_agent) VALUES ($1, $2, $3)`,
      sourceId,
      hashIp(request.ip),
      request.headers['user-agent'] ?? null
    );

    return reply.redirect(link.miniapp_link, 302);
  });

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

async function listChannelLinks(): Promise<GrowthChannelLinkData[]> {
  const rows = await prisma.$queryRawUnsafe<GrowthChannelLinkData[]>(
    `SELECT * FROM growth.channel_link_stats ORDER BY created_at DESC`
  );
  return rows.map(normalizeLinkRow);
}

async function getChannelLink(sourceId: string): Promise<GrowthChannelLinkData | null> {
  const rows = await prisma.$queryRawUnsafe<GrowthChannelLinkData[]>(
    `SELECT * FROM growth.channel_link_stats WHERE source_id = $1 LIMIT 1`,
    sourceId
  );
  return rows[0] ? normalizeLinkRow(rows[0]) : null;
}

function normalizeLinkRow(row: GrowthChannelLinkData): GrowthChannelLinkData {
  return {
    ...row,
    click_count: Number(row.click_count ?? 0),
    enter_count: Number(row.enter_count ?? 0),
    unique_enter_count: Number(row.unique_enter_count ?? 0),
    activated_user_count: Number(row.activated_user_count ?? 0),
  };
}

async function generateSourceId(): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const sourceId = randomBytes(5).toString('base64url');
    const existing = await getChannelLink(sourceId);
    if (!existing) return sourceId;
  }
  throw new Error('生成渠道暗参失败，请手动填写 source_id');
}

function buildMiniappLink(sourceId: string): string {
  const botUsername = (
    process.env.GROWTH_BOT_USERNAME ||
    process.env.BOT_USERNAME ||
    'MIJINGAI_bot'
  )
    .replace(/^@/, '')
    .trim();
  const miniappShortName =
    (process.env.MINIAPP_SHORT_NAME || 'app').replace(/^\/+|\/+$/g, '') || 'app';
  return `https://t.me/${botUsername}/${miniappShortName}?startapp=${encodeURIComponent(sourceId)}`;
}

function buildTrackingLink(request: FastifyRequest, sourceId: string): string {
  const configuredBase = process.env.GROWTH_TRACKING_BASE_URL?.replace(/\/$/, '');
  const origin = configuredBase || `${request.protocol}://${request.headers.host}`;
  return `${origin}/api/growth/click/${encodeURIComponent(sourceId)}`;
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

function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

async function requireCsAdmin(request: GrowthRequest, reply: FastifyReply) {
  const headerToken = request.headers[ADMIN_HEADER];
  const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  const isDevBypass = config.nodeEnv !== 'production' && process.env.DEV_AUTH_BYPASS === '1';

  if (!config.csAdminToken && isDevBypass) {
    request.csOperatorId = getOperator(request);
    return;
  }

  if (!config.csAdminToken || token !== config.csAdminToken) {
    return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
  }

  request.csOperatorId = getOperator(request);
}

function getOperator(request: FastifyRequest): string {
  const value = request.headers[OPERATOR_HEADER];
  const operator = Array.isArray(value) ? value[0] : value;
  return operator?.trim() || 'cs-operator';
}

async function getTrafficBotlink(sourceId: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM miniapp_traffic.botlinks WHERE source_id = $1 LIMIT 1`,
    sourceId
  );
  return rows[0] || null;
}
