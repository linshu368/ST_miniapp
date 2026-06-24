/**
 * backend / routes / llm-proxy.ts
 *
 * LLM 代理网关：/api/platform/llm-proxy/v1/*
 *
 * ST 配置 LLM endpoint 指向此路由。职责：
 *   1. 接收 ST 发出的 OpenAI 兼容请求
 *   2. 注入平台持有的真实 API key
 *   3. 转发到上游 LLM provider（SSE 流式透传）
 *   4. 不承担消息双写
 *
 * 鉴权：通过 LLM_PROXY_SECRET 共享密钥校验，调用方须在
 *       Authorization: Bearer <secret> 中携带。未配置密钥时拒绝所有请求。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';

const LLM_UPSTREAM_URL = process.env.LLM_UPSTREAM_URL || 'https://openrouter.ai/api/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const LLM_PROXY_SECRET = process.env.LLM_PROXY_SECRET || '';

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function requireProxySecret(request: FastifyRequest, reply: FastifyReply) {
  if (!LLM_PROXY_SECRET) {
    request.log.warn('[llm-proxy] LLM_PROXY_SECRET not configured, rejecting request');
    return reply.status(403).send({
      error: {
        message: 'LLM proxy not available: missing proxy secret configuration',
        type: 'configuration_error',
      },
    });
  }

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: {
        message: 'Missing or invalid Authorization header',
        type: 'auth_error',
      },
    });
  }

  const token = authHeader.slice(7);
  if (!safeEqual(token, LLM_PROXY_SECRET)) {
    request.log.warn('[llm-proxy] invalid proxy secret');
    return reply.status(403).send({
      error: {
        message: 'Invalid proxy secret',
        type: 'auth_error',
      },
    });
  }
}

export default async function llmProxyRoutes(app: FastifyInstance) {
  app.all(
    '/api/platform/llm-proxy/v1/*',
    { preHandler: [requireProxySecret] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!LLM_API_KEY) {
        return reply.status(503).send({
          error: {
            message: 'LLM proxy not configured: missing API key',
            type: 'configuration_error',
          },
        });
      }

      const subPath = request.url.replace(/^\/api\/platform\/llm-proxy\/v1/, '') || '/';
      const targetUrl = `${LLM_UPSTREAM_URL}${subPath}`;

      const forwardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'ST_miniAPP',
      };

      let bodyInit: BodyInit | undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const rawBody = request.body;
        if (rawBody instanceof Buffer) {
          bodyInit = new Uint8Array(rawBody) as BodyInit;
        } else if (rawBody !== null && rawBody !== undefined) {
          bodyInit = JSON.stringify(rawBody);
        }
      }

      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(targetUrl, {
          method: request.method,
          headers: forwardHeaders,
          body: bodyInit,
          // @ts-expect-error Node 18+ fetch supports duplex
          duplex: 'half',
        });
      } catch (err) {
        request.log.error({ err: String(err), targetUrl }, '[llm-proxy] upstream request failed');
        return reply.status(502).send({
          error: { message: `Upstream error: ${String(err)}`, type: 'upstream_error' },
        });
      }

      reply.status(upstreamRes.status);

      const STRIP_HEADERS = new Set([
        'transfer-encoding',
        'connection',
        'content-encoding',
        'content-length',
      ]);
      upstreamRes.headers.forEach((value, key) => {
        if (!STRIP_HEADERS.has(key.toLowerCase())) {
          reply.header(key, value);
        }
      });

      if (upstreamRes.body) {
        const nodeStream = Readable.fromWeb(
          upstreamRes.body as import('stream/web').ReadableStream
        );
        return reply.send(nodeStream);
      }

      const text = await upstreamRes.text();
      return reply.send(text);
    }
  );
}
