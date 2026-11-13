import Fastify from 'fastify';
import { get } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createObserver } from './core.js';
import { currentContext, requestId } from './context.js';
import { registerHttpObservation } from './http.js';
import type { ObservationEvent } from './events.js';

function setup() {
  const records: ObservationEvent[] = [];
  const observer = createObserver([
    (event) => {
      records.push(event);
    },
  ]);
  const app = Fastify({ logger: false, genReqId: (req) => requestId(req.headers['x-request-id']) });
  registerHttpObservation(app, observer);
  return { app, records, observer };
}

describe('HTTP observation', () => {
  it('records a real socket disconnect without inventing a completed response', async () => {
    const { app, records } = setup();
    app.get('/disconnect', async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write(': connected\n\n');
    });
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      await new Promise<void>((resolve, reject) => {
        const client = get(`${origin}/disconnect`, (response) => {
          response.once('data', () => {
            response.destroy();
            resolve();
          });
        });
        client.on('error', reject);
      });
      await vi.waitFor(() => {
        const terminal = records.filter((record) => record.event === 'operation.terminal');
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({
          outcome: 'interrupted',
          outcome_known: false,
          http_status: 200,
        });
      });
    } finally {
      await app.close();
    }
  });
  it('records one terminal for success, unknown routes, parse errors, rejection and exceptions without changing responses', async () => {
    const { app, records } = setup();
    app.get('/success', async () => ({ success: true, data: { body: 'private-data' } }));
    app.get('/denied', async (_request, reply) =>
      reply
        .code(401)
        .send({ success: false, error: { code: 'UNAUTHORIZED', message: 'private-data' } })
    );
    app.get('/throw', async () => {
      throw new Error('private-data');
    });
    app.post('/parse', async () => ({ success: true }));
    try {
      for (const [url, expected] of [
        ['/success', 200],
        ['/missing?secret=private-data', 404],
        ['/denied', 401],
        ['/throw', 500],
      ] as const) {
        const response = await app.inject({ url, headers: { 'x-request-id': `r-${expected}` } });
        expect(response.statusCode).toBe(expected);
        expect(response.headers['x-request-id']).toBe(`r-${expected}`);
        expect(response.headers['x-trace-id']).toMatch(/^[a-f0-9]{32}$/);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/parse',
            headers: { 'content-type': 'application/json' },
            payload: '{',
          })
        ).statusCode
      ).toBe(400);
      const terminals = records.filter((record) => record.event === 'operation.terminal');
      expect(terminals).toHaveLength(5);
      expect(terminals.map((record) => record.http_status)).toEqual([200, 404, 401, 500, 400]);
      expect(terminals[2]?.public_error_code).toBe('UNAUTHORIZED');
      expect(JSON.stringify(records)).not.toContain('private-data');
      expect(terminals[1]?.route).toBe('unmatched');
    } finally {
      await app.close();
    }
  });

  it('propagates request context through overlapping handlers and nested observations', async () => {
    const { app, observer, records } = setup();
    app.get('/parallel', async (request) =>
      observer.observe('test.nested', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(currentContext()?.request_id).toBe(request.id);
        return { success: true };
      })
    );
    try {
      await Promise.all(
        ['one', 'two'].map((id) =>
          app.inject({ url: '/parallel', headers: { 'x-request-id': id } })
        )
      );
      for (const id of ['one', 'two']) {
        const group = records.filter((record) => record.request_id === id);
        expect(group).toHaveLength(4);
        expect(new Set(group.map((record) => record.trace_id)).size).toBe(1);
      }
      expect(currentContext()).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('observes hijacked SSE transport once without claiming business success', async () => {
    const { app, records } = setup();
    app.get('/stream', async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.end('event: error\ndata: {"code":"upstream_error"}\n\n');
    });
    try {
      const response = await app.inject('/stream');
      expect(response.statusCode).toBe(200);
      const terminals = records.filter((record) => record.event === 'operation.terminal');
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        http_status: 200,
        outcome: 'unknown',
        outcome_known: false,
      });
    } finally {
      await app.close();
    }
  });
});
