/**
 * backend / middleware / stProxy.ts
 *
 * ST 反向代理：将 /api/bridge/st/* 的请求透明转发到 ST 原生服务。
 *
 * 设计要点：
 *   1. Cookie 透传：前端请求携带的 connect.sid 原样转发给 ST
 *   2. 路径重写：/api/bridge/st/foo → ST_BASE_URL/foo
 *   3. 响应头透传：ST 返回的 Set-Cookie、Content-Type 等全部透传
 *   4. 流式响应：SSE / 大文件直接 pipe，不在内存中缓冲
 *   5. 阶段二 iframe：iframe.src = Bridge/api/bridge/st/，零改动
 *
 * 使用方式（app.ts）：
 *   app.all('/api/bridge/st/*', stProxyHandler);
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../platform/config.js';
import { Readable } from 'node:stream';

// 不透传给 ST 的请求头（由 Node fetch 自动处理或会导致问题）
const HOP_BY_HOP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

// 不透传给客户端的响应头
const HOP_BY_HOP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export async function stProxyHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // 路径重写：/api/bridge/st/foo?bar=1 → ST_BASE_URL/foo?bar=1
  const rawUrl = request.url; // /api/bridge/st/foo?bar=1
  const stripped = rawUrl.replace(/^\/api\/bridge\/st/, '') || '/';
  const targetUrl = `${config.stBaseUrl}${stripped}`;

  // 构造转发请求头（过滤 hop-by-hop，保留 cookie）
  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP_REQUEST.has(key.toLowerCase()) && typeof value === 'string') {
      forwardHeaders[key] = value;
    }
  }
  // 确保 host 指向 ST
  forwardHeaders['host'] = new URL(config.stBaseUrl).host;

  // 请求体：GET/HEAD 没有 body
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let bodyInit: BodyInit | undefined;
  if (hasBody) {
    const rawBody = request.body;
    if (rawBody instanceof Buffer) {
      // addContentTypeParser 解析为 buffer（如 multipart）
      bodyInit = new Uint8Array(rawBody) as BodyInit;
    } else if (rawBody !== null && rawBody !== undefined) {
      // JSON 或其他已解析对象，重新序列化
      bodyInit = JSON.stringify(rawBody);
      if (!forwardHeaders['content-type']) {
        forwardHeaders['content-type'] = 'application/json';
      }
    }
  }

  let stRes: Response;
  try {
    stRes = await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: bodyInit,
      // @ts-expect-error — Node 18+ fetch 支持 duplex 但类型定义滞后
      duplex: 'half',
      redirect: 'manual', // 让重定向原样返回给客户端
    });
  } catch (err) {
    request.log.error({ err: String(err), targetUrl }, '[stProxy] 上游请求失败');
    return reply.status(502).send({ error: 'bad_gateway', message: String(err) });
  }

  // 透传响应状态码
  reply.status(stRes.status);

  // 透传响应头（过滤 hop-by-hop）
  stRes.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_RESPONSE.has(key.toLowerCase())) {
      reply.header(key, value);
    }
  });

  // 透传响应体（流式，不缓冲）
  if (stRes.body) {
    // Node 18+ ReadableStream → Node Readable
    const nodeStream = Readable.fromWeb(stRes.body as import('stream/web').ReadableStream);
    return reply.send(nodeStream);
  }

  return reply.send('');
}
