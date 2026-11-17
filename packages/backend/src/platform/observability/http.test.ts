import Fastify from 'fastify';
import { get } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createObserver } from './core.js';
import { bindBusinessContext, currentContext, requestId } from './context.js';
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
  it.each([
    ['/api/v1/conversations/:sessionId/messages/:messageId/voice', 'voice', 'session_id'],
    [
      '/api/v1/conversations/:sessionId/messages/:messageId/image-description',
      'image',
      'session_id',
    ],
    ['/api/image-plaza/conversations/:conversationId/attempts', 'image', 'image_conversation_id'],
    ['/api/image-plaza/attempts/:attemptId', 'image', 'attempt_id'],
    ['/api/image-plaza/works/:workId', 'image', 'work_id'],
    ['/api/growth/prompts', 'growth', undefined],
    ['/api/v1/drama-survey', 'growth', undefined],
    ['/api/telegram/community-webhook', 'community', undefined],
    ['/api/payment/orders/:id', 'payment', undefined],
  ] as const)('correlates the explicit target of %s', async (route, business_module, field) => {
    const { app, records } = setup();
    const id = '11111111-1111-4111-8111-111111111111';
    app.get(route, async () => ({ success: false }));
    try {
      await app.inject(route.replace(/:[A-Za-z]+/g, id));
      expect(records.at(-1)).toMatchObject({ business_module });
      if (field) expect(records.at(-1)).toHaveProperty(field, id);
      if (business_module === 'image' && field !== 'session_id')
        expect(records.at(-1)).not.toHaveProperty('session_id');
      if (route.includes(':messageId')) expect(records.at(-1)).toHaveProperty('message_id', id);
    } finally {
      await app.close();
    }
  });

  it('projects only named image request/response IDs and never infers user identity from payloads', async () => {
    const { app, records } = setup();
    const id = '11111111-1111-4111-8111-111111111111';
    app.post('/api/image-plaza/share', async () => ({
      success: true,
      data: { work: { id }, user_id: id, prompt: 'private' },
    }));
    app.post('/api/image-plaza/conversations', async () => ({
      success: true,
      data: { conversation: { id, messages: ['private'] } },
    }));
    try {
      await app.inject({
        method: 'POST',
        url: '/api/image-plaza/share',
        payload: { artifact_id: id, user_id: id, text: 'private' },
      });
      expect(records.at(-1)).toMatchObject({
        business_module: 'image',
        artifact_id: id,
        work_id: id,
      });
      expect(records.at(-1)).not.toHaveProperty('user_id');
      await app.inject({
        method: 'POST',
        url: '/api/image-plaza/conversations',
        payload: { source_work_id: id },
      });
      expect(records.at(-1)).toMatchObject({ image_conversation_id: id, work_id: id });
      expect(records.at(-1)).not.toHaveProperty('session_id');
      expect(JSON.stringify(records)).not.toContain('private');
    } finally {
      await app.close();
    }
  });
  it('preserves business targets on failures and later user identity on concurrent terminals', async () => {
    const { app, records, observer } = setup();
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    app.get('/api/v1/conversations/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      bindBusinessContext({ user_id: id, character_id: id });
      await observer.observe('db.read', async () => {
        await Promise.resolve();
      });
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND' } });
    });
    app.get('/api/creator/characters/:id', async (_request, reply) => reply.code(401).send({}));
    app.get('/api/dramas/:id', async () => {
      throw new Error('private');
    });
    try {
      await Promise.all([first, second].map((id) => app.inject(`/api/v1/conversations/${id}`)));
      for (const id of [first, second]) {
        const events = records.filter((record) => record.session_id === id);
        expect(events).toHaveLength(4);
        const terminal = events.find(
          (record) => record.operation === 'http.request' && record.event === 'operation.terminal'
        );
        expect(terminal).toMatchObject({
          user_id: id,
          character_id: id,
          business_module: 'chat',
          http_status: 404,
        });
        expect(
          events
            .filter((record) => record.operation === 'db.read')
            .every((record) => record.user_id === id)
        ).toBe(true);
      }
      await app.inject(`/api/creator/characters/${first}`);
      expect(records.at(-1)).toMatchObject({
        business_module: 'creator',
        character_id: first,
        creation_id: first,
        http_status: 401,
      });
      expect(records.at(-1)).not.toHaveProperty('user_id');
      await app.inject('/api/dramas/private-invalid-id');
      expect(records.at(-1)).toMatchObject({ business_module: 'drama', http_status: 500 });
      expect(records.at(-1)).not.toHaveProperty('drama_id');
      expect(JSON.stringify(records)).not.toContain('private');
    } finally {
      await app.close();
    }
  });
  it.each([false, true])('keeps rejection levels consistent with hijacked=%s', async (hijacked) => {
    const { app, records } = setup();
    for (const status of [401, 403, 409, 429]) {
      app.get(`/status/${status}`, async (_request, reply) => {
        if (hijacked) {
          reply.hijack();
          reply.raw.writeHead(status, { 'content-type': 'application/json' });
          reply.raw.end('{}');
        } else return reply.code(status).send({ success: false, error: { code: 'REJECTED' } });
      });
    }
    try {
      for (const status of [401, 403, 409, 429])
        expect((await app.inject(`/status/${status}`)).statusCode).toBe(status);
      const terminals = records.filter((record) => record.event === 'operation.terminal');
      expect(terminals).toHaveLength(4);
      expect(
        terminals.every((record) => record.level === 'warn' && record.outcome === 'rejected')
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('records a real socket disconnect without inventing a completed response', async () => {
    const { app, records } = setup();
    app.get('/disconnect', async (_request, reply) => {
      bindBusinessContext({ user_id: '11111111-1111-4111-8111-111111111111' });
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
          user_id: '11111111-1111-4111-8111-111111111111',
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
      expect(terminals.map((record) => record.level)).toEqual([
        'info',
        'info',
        'warn',
        'error',
        'info',
      ]);
      expect(terminals[2]?.public_error_code).toBe('UNAUTHORIZED');
      expect(JSON.stringify(records)).not.toContain('private-data');
      expect(terminals[1]?.route).toBe('unmatched');
    } finally {
      await app.close();
    }
  });

  it('propagates request context through overlapping handlers and nested observations', async () => {
    const { app, observer, records } = setup();
    for (const route of ['/parallel', '/parallel-two'])
      app.get(route, async (request) =>
        observer.observe('test.nested', async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          expect(currentContext()?.request_id).toBe(request.id);
          return { success: true };
        })
      );
    try {
      await Promise.all(
        ['one', 'two'].map((id, index) =>
          app.inject({
            url: index === 0 ? '/parallel' : '/parallel-two',
            headers: { 'x-request-id': id },
          })
        )
      );
      for (const id of ['one', 'two']) {
        const group = records.filter((record) => record.request_id === id);
        expect(group).toHaveLength(4);
        expect(new Set(group.map((record) => record.trace_id)).size).toBe(1);
        expect(
          group.every(
            (record) => record.call_scene === (id === 'one' ? 'GET:/parallel' : 'GET:/parallel-two')
          )
        ).toBe(true);
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
