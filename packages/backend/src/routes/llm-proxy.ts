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
 * 开发环境：跳过 userId 验证，直接转发
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';

const LLM_UPSTREAM_URL = process.env.LLM_UPSTREAM_URL || 'https://openrouter.ai/api/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

export default async function llmProxyRoutes(app: FastifyInstance) {
  app.all('/api/platform/llm-proxy/v1/*', async (request: FastifyRequest, reply: FastifyReply) => {
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
      const nodeStream = Readable.fromWeb(upstreamRes.body as import('stream/web').ReadableStream);
      return reply.send(nodeStream);
    }

    const text = await upstreamRes.text();
    return reply.send(text);
  });
}
