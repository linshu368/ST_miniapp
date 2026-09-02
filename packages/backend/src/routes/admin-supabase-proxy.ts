import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../platform/config.js';
import { getSupabaseClient } from '../lib/supabase.js';

const ALLOWED_PATH_PREFIXES = ['auth/v1/', 'rest/v1/', 'storage/v1/'];
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-profile',
  'apikey',
  'authorization',
  'content-profile',
  'content-type',
  'prefer',
  'range',
  'x-client-info',
  'x-supabase-api-version',
];
const FORWARDED_RESPONSE_HEADERS = [
  'content-range',
  'content-type',
  'location',
  'range-unit',
  'retry-after',
  'x-supabase-api-version',
];

export function buildSupabaseProxyTarget(
  supabaseUrl: string,
  requestedPath: string,
  requestUrl: string
): URL {
  const path = requestedPath.replace(/^\/+/, '');
  if (!ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new Error('Unsupported Supabase proxy path');
  }

  const queryIndex = requestUrl.indexOf('?');
  const query = queryIndex >= 0 ? requestUrl.slice(queryIndex) : '';
  return new URL(`${path}${query}`, `${supabaseUrl.replace(/\/+$/, '')}/`);
}

function buildUpstreamUrl(request: FastifyRequest): URL {
  return buildSupabaseProxyTarget(
    config.supabase.url,
    (request.params as { '*': string })['*'],
    request.url
  );
}

function buildRequestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

function serializeBody(request: FastifyRequest): BodyInit | undefined {
  if (request.method === 'GET' || request.method === 'HEAD' || request.body === undefined) {
    return undefined;
  }
  if (typeof request.body === 'string') return request.body;
  if (Buffer.isBuffer(request.body)) return request.body as unknown as BodyInit;
  return JSON.stringify(request.body);
}

/**
 * 校验请求携带的 admin session 属于当前环境的 owner/operator。
 * 校验失败时已向 reply 写入 401/403，调用方直接 return reply 即可。
 */
async function authorizeAdminOperator(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const authorization = request.headers.authorization;
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    await reply.status(401).send({ message: 'Admin session is required' });
    return false;
  }

  const supabase = getSupabaseClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user) {
    await reply.status(401).send({ message: 'Admin session is invalid' });
    return false;
  }

  const { data: adminUser, error: adminError } = await supabase
    .schema('admin')
    .from('admin_users')
    .select('role,can_access_test,can_access_prod')
    .eq('user_id', user.id)
    .maybeSingle();
  const canAccessEnvironment =
    config.database.target === 'production'
      ? adminUser?.can_access_prod
      : adminUser?.can_access_test;
  if (
    adminError ||
    !adminUser ||
    !['owner', 'operator'].includes(adminUser.role) ||
    !canAccessEnvironment
  ) {
    await reply.status(403).send({ message: 'Operator access is required' });
    return false;
  }
  return true;
}

/** 只认文件本体的魔数，不信客户端声明的 MIME（与 character-assets 的 PNG 签名校验同思路）。 */
function sniffPosterImage(image: Buffer): { extension: string; contentType: string } | null {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (image.length >= 8 && image.subarray(0, 8).equals(pngSignature)) {
    return { extension: 'png', contentType: 'image/png' };
  }
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
    return { extension: 'jpg', contentType: 'image/jpeg' };
  }
  if (
    image.length >= 12 &&
    image.subarray(0, 4).toString('ascii') === 'RIFF' &&
    image.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: 'webp', contentType: 'image/webp' };
  }
  return null;
}

const INVITE_POSTER_BUCKET = 'miniapp-invite-posters';
const INVITE_POSTER_MAX_BYTES = 10 * 1024 * 1024;

export default async function adminSupabaseProxyRoutes(app: FastifyInstance) {
  // @frontend-ready: true —— admin 素材编辑器上传邀请海报，返回 public URL 由运营写进 poster_url
  app.post(
    '/api/admin/invite-poster',
    // base64 使体积膨胀约 1/3，为 10 MB 原图留足请求体余量
    { bodyLimit: 15 * 1024 * 1024 },
    async (request, reply) => {
      if (!(await authorizeAdminOperator(request, reply))) return reply;

      const body = request.body as { imageBase64?: unknown };
      if (typeof body?.imageBase64 !== 'string' || body.imageBase64.length === 0) {
        return reply.status(400).send({ message: 'Poster image data is required' });
      }
      const image = Buffer.from(body.imageBase64, 'base64');
      const sniffed = sniffPosterImage(image);
      if (!sniffed || image.length > INVITE_POSTER_MAX_BYTES) {
        return reply.status(400).send({ message: '仅支持不超过 10 MB 的 PNG / JPG / WEBP 图片' });
      }

      // 每次上传落新对象（时间戳 + 随机段），不覆盖旧对象：
      // poster_url 经 config 发布/回滚引用历史 URL，覆盖同一路径会让旧版本指向新图。
      const storagePath = `posters/${Date.now()}-${randomUUID().slice(0, 8)}.${sniffed.extension}`;
      const supabase = getSupabaseClient();
      const { error: uploadError } = await supabase.storage
        .from(INVITE_POSTER_BUCKET)
        .upload(storagePath, image, { contentType: sniffed.contentType, upsert: false });
      if (uploadError) {
        request.log.error({ err: uploadError, storagePath }, 'Invite poster upload failed');
        return reply.status(502).send({
          message: '邀请海报上传失败，请确认迁移 107 已执行（miniapp-invite-posters 桶存在）',
        });
      }

      const posterUrl = `${config.supabase.url}/storage/v1/object/public/${INVITE_POSTER_BUCKET}/${storagePath}`;
      return reply.send({ posterUrl });
    }
  );

  // @frontend-ready: true —— admin 角色卡头像上传
  app.post(
    '/api/admin/character-assets/:characterId',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      if (!(await authorizeAdminOperator(request, reply))) return reply;

      const { prisma } = await import('../lib/db.js');
      const { characterId } = request.params as { characterId: string };
      const body = request.body as { pngBase64?: unknown };
      if (typeof body?.pngBase64 !== 'string') {
        return reply.status(400).send({ message: 'PNG image data is required' });
      }
      const png = Buffer.from(body.pngBase64, 'base64');
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (
        png.length === 0 ||
        png.length > 5 * 1024 * 1024 ||
        !png.subarray(0, pngSignature.length).equals(pngSignature)
      ) {
        return reply.status(400).send({ message: 'Only PNG images up to 5 MB are supported' });
      }

      const character = await prisma.character.findUnique({
        where: { id: characterId },
        select: { id: true },
      });
      if (!character) return reply.status(404).send({ message: 'Character not found' });

      const bucket = process.env.CHARACTER_STORAGE_BUCKET || 'character-assets';
      const storagePath = `characters/platform_${characterId}.png`;
      const supabase = getSupabaseClient();
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(storagePath, png, { contentType: 'image/png', upsert: true });
      if (uploadError) {
        request.log.error({ err: uploadError, characterId }, 'Character avatar upload failed');
        return reply.status(502).send({ message: 'Character avatar upload failed' });
      }

      const avatarUrl = `${config.supabase.url}/storage/v1/object/public/${bucket}/${storagePath}`;
      await prisma.character.update({
        where: { id: characterId },
        data: { avatar_url: avatarUrl, updated_at: new Date() },
      });
      return reply.send({ avatarUrl });
    }
  );

  // @frontend-ready: true —— admin 前端的 Supabase 请求统一代理
  app.all('/api/admin/supabase/*', async (request, reply) => {
    if (!config.supabase.url) {
      return reply.status(503).send({ message: 'Supabase proxy is not configured' });
    }

    let upstreamUrl: URL;
    try {
      upstreamUrl = buildUpstreamUrl(request);
    } catch {
      return reply.status(404).send({ message: 'Unsupported Supabase proxy path' });
    }

    try {
      const response = await fetch(upstreamUrl, {
        method: request.method,
        headers: buildRequestHeaders(request),
        body: serializeBody(request),
        redirect: 'manual',
      });

      reply.status(response.status);
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value) reply.header(name, value);
      }
      return reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      request.log.error({ err: error, upstreamUrl: upstreamUrl.origin }, 'Supabase proxy failed');
      return reply.status(502).send({ message: 'Supabase 暂时无法访问，请稍后重试' });
    }
  });
}
