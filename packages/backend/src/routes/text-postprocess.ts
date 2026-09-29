import type { FastifyInstance } from 'fastify';
import {
  DiscardTextPostprocessDraftRequestSchema,
  PublishTextPostprocessRequestSchema,
  ReadTextPostprocessVersionsRequestSchema,
  RollbackTextPostprocessRequestSchema,
  SaveTextPostprocessDraftRequestSchema,
  fail,
  ok,
  parseTextPostprocessDraft,
  type TextPostprocessDiagnostic,
} from '@miniapp/shared';
import { AdminSessionError, requireAdminActor } from '../features/admin-access/session.js';
import {
  discardTextPostprocessDraft,
  publishTextPostprocess,
  readTextPostprocessAdminState,
  readTextPostprocessRequest,
  readTextPostprocessVersions,
  rollbackTextPostprocess,
  saveTextPostprocessDraft,
} from '../features/text-postprocess/service.js';
import {
  safeTextPostprocessError,
  TextPostprocessRequestError,
} from '../features/text-postprocess/errors.js';
import { requireTelegramAuth } from '../middleware/auth.js';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

export default async function textPostprocessRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.post(
    '/api/v1/text-postprocess/versions',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const parsed = ReadTextPostprocessVersionsRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(fail('BAD_REQUEST', 'Version batch is invalid.'));
      }
      const startedAt = Date.now();
      try {
        const data = await readTextPostprocessVersions(parsed.data.versions);
        request.log.info(
          {
            event: 'text_postprocess.versions.read',
            requestId: request.id,
            requested: parsed.data.versions.length,
            found: data.found.length,
            unavailable: data.unavailable_versions.length,
            durationMs: Date.now() - startedAt,
          },
          'text postprocess versions read'
        );
        return reply.send(ok(data));
      } catch (error) {
        request.log.error(
          {
            event: 'text_postprocess.versions.failed',
            requestId: request.id,
            err: safeTextPostprocessError(error),
          },
          'text postprocess versions read failed'
        );
        return reply
          .status(500)
          .send(fail('TEXT_POSTPROCESS_FAILED', 'Text postprocess versions could not be read.'));
      }
    }
  );

  // @frontend-ready: true
  app.get('/api/admin/text-postprocess', async (request, reply) => {
    const actor = await readActor(request.headers.authorization, 'read', reply);
    if (!actor) return reply;
    const query = request.query as { limit?: unknown; before_version?: unknown };
    const startedAt = Date.now();
    try {
      const data = await readTextPostprocessAdminState({
        limit: positiveInt(query.limit) ?? 20,
        beforeVersion: positiveInt(query.before_version),
      });
      request.log.info(
        {
          event: 'text_postprocess.admin.read',
          requestId: request.id,
          runtimeVersion: data.runtime_version,
          history: data.history.length,
          hasDraft: data.draft !== null,
          durationMs: Date.now() - startedAt,
        },
        'text postprocess admin state read'
      );
      return reply.send(ok(data));
    } catch (error) {
      return sendFailure(reply, request.log, error, startedAt, request.id);
    }
  });

  // @frontend-ready: true
  app.get('/api/admin/text-postprocess/requests/:requestId', async (request, reply) => {
    const actor = await readActor(request.headers.authorization, 'read', reply);
    if (!actor) return reply;
    const requestId = (request.params as { requestId?: string }).requestId ?? '';
    if (!REQUEST_ID.test(requestId)) {
      return reply.status(400).send(fail('BAD_REQUEST', 'Request id is invalid.'));
    }
    const startedAt = Date.now();
    try {
      const data = await readTextPostprocessRequest(actor.userId, requestId);
      request.log.info(
        {
          event: 'text_postprocess.request.read',
          requestId: request.id,
          mutationRequestId: requestId,
          found: data.outcome !== null,
          durationMs: Date.now() - startedAt,
        },
        'text postprocess request lookup'
      );
      return reply.send(ok(data));
    } catch (error) {
      return sendFailure(reply, request.log, error, startedAt, request.id, requestId);
    }
  });

  // @frontend-ready: true
  app.post('/api/admin/text-postprocess/draft', async (request, reply) => {
    const actor = await readActor(request.headers.authorization, 'write', reply);
    if (!actor) return reply;
    if (isRecord(request.body)) {
      const source = parseTextPostprocessDraft(request.body.source);
      if (!source.ok)
        return sendMutation(reply, mutationFromDiagnostics('invalid_draft', source.diagnostics));
    }
    const parsed = SaveTextPostprocessDraftRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('BAD_REQUEST', 'Draft request is invalid.'));
    }
    return runWrite(
      request,
      reply,
      actor.userId,
      parsed.data.request_id,
      'text_postprocess.draft.save',
      () => saveTextPostprocessDraft(actor.userId, parsed.data)
    );
  });

  // @frontend-ready: true
  app.post('/api/admin/text-postprocess/publish', async (request, reply) => {
    const actor = await readActor(request.headers.authorization, 'write', reply);
    if (!actor) return reply;
    const parsed = PublishTextPostprocessRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send(fail('BAD_REQUEST', 'Publish request is invalid.'));
    return runWrite(
      request,
      reply,
      actor.userId,
      parsed.data.request_id,
      'text_postprocess.publish',
      () => publishTextPostprocess(actor.userId, parsed.data)
    );
  });

  // @frontend-ready: true
  app.post('/api/admin/text-postprocess/rollback', async (request, reply) => {
    const actor = await readActor(request.headers.authorization, 'write', reply);
    if (!actor) return reply;
    const parsed = RollbackTextPostprocessRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send(fail('BAD_REQUEST', 'Rollback request is invalid.'));
    return runWrite(
      request,
      reply,
      actor.userId,
      parsed.data.request_id,
      'text_postprocess.rollback',
      () => rollbackTextPostprocess(actor.userId, parsed.data)
    );
  });

  // @frontend-ready: true
  app.post('/api/admin/text-postprocess/discard', async (request, reply) => {
    const actor = await readActor(request.headers.authorization, 'write', reply);
    if (!actor) return reply;
    const parsed = DiscardTextPostprocessDraftRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send(fail('BAD_REQUEST', 'Discard request is invalid.'));
    return runWrite(
      request,
      reply,
      actor.userId,
      parsed.data.request_id,
      'text_postprocess.discard',
      () => discardTextPostprocessDraft(actor.userId, parsed.data)
    );
  });
}

async function readActor(
  authorization: string | undefined,
  access: 'read' | 'write',
  reply: { status: (code: number) => { send: (body: unknown) => unknown } }
): Promise<{ userId: string } | null> {
  try {
    return await requireAdminActor(authorization, access);
  } catch (error) {
    if (error instanceof AdminSessionError) {
      await reply
        .status(error.statusCode)
        .send(fail(error.statusCode === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', error.message));
      return null;
    }
    throw error;
  }
}

async function runWrite(
  request: { id: string; log: { info: Function; error: Function } },
  reply: {
    status: (code: number) => { send: (body: unknown) => unknown };
    send: (body: unknown) => unknown;
  },
  actorUserId: string,
  mutationRequestId: string,
  event: string,
  action: () => Promise<{ version?: number; runtime_version?: number | null; replayed: boolean }>
) {
  const startedAt = Date.now();
  try {
    const outcome = await action();
    request.log.info(
      {
        event,
        requestId: request.id,
        actorUserId,
        mutationRequestId,
        version: outcome.version ?? outcome.runtime_version ?? null,
        replayed: outcome.replayed,
        durationMs: Date.now() - startedAt,
      },
      'text postprocess mutation finished'
    );
    return reply.send(ok(outcome));
  } catch (error) {
    return sendFailure(reply, request.log, error, startedAt, request.id, mutationRequestId, event);
  }
}

function sendFailure(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  log: { error: Function },
  error: unknown,
  startedAt: number,
  requestId: string,
  mutationRequestId?: string,
  event = 'text_postprocess.failed'
) {
  const known = error instanceof TextPostprocessRequestError ? error : null;
  log.error(
    {
      event,
      requestId,
      mutationRequestId,
      code: known?.code ?? 'TEXT_POSTPROCESS_FAILED',
      durationMs: Date.now() - startedAt,
      err: safeTextPostprocessError(error),
    },
    'text postprocess request failed'
  );
  if (!known) {
    return reply
      .status(500)
      .send(fail('TEXT_POSTPROCESS_FAILED', 'Text postprocess request failed.'));
  }
  if (known.diagnostics.length > 0) {
    return reply.status(known.statusCode).send({
      success: false,
      error: { code: known.code, message: known.message, diagnostics: known.diagnostics },
    });
  }
  return reply.status(known.statusCode).send(fail(known.code, known.message));
}

function sendMutation(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  error: TextPostprocessRequestError
) {
  return reply.status(error.statusCode).send({
    success: false,
    error: { code: error.code, message: error.message, diagnostics: error.diagnostics },
  });
}

function mutationFromDiagnostics(
  code: 'invalid_draft' | 'invalid_source',
  diagnostics: TextPostprocessDiagnostic[]
): TextPostprocessRequestError {
  return new TextPostprocessRequestError(
    400,
    code,
    code === 'invalid_draft'
      ? 'The text postprocess draft is invalid.'
      : 'The text postprocess source is invalid.',
    diagnostics
  );
}
