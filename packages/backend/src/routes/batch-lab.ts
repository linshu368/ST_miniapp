import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  batchLabCreateProcessorVersionRequestSchema,
  batchLabCreateSampleSetRequestSchema,
  batchLabProcessorPreviewRequestSchema,
  batchLabPreviewRequestSchema,
  fail,
  ok,
  type BatchLabContext,
  type BatchLabErrorCode,
} from '@miniapp/shared';
import {
  BatchLabRepositoryError,
  BatchLabSampleRepository,
} from '../infrastructure/repositories/BatchLabSampleRepository.js';
import { BatchLabPostprocessingService } from '../features/batch-lab/postprocessing-service.js';
import { BatchLabSampleService } from '../features/batch-lab/sample-service.js';
import { verifyBatchLabSourceConnection } from '../features/batch-lab/source-database.js';
import { BatchLabSourceQueryError } from '../features/batch-lab/source-query.js';
import { config } from '../platform/config.js';

export default async function batchLabRoutes(app: FastifyInstance) {
  // @frontend-ready: true — Batch Lab 工程骨架使用的权威环境与能力入口
  app.get('/api/batch-lab/context', async (request, reply) => {
    if (!config.batchLab.enabled) {
      return reply
        .status(503)
        .send(fail('BATCH_LAB_DISABLED', 'Batch Lab is not enabled for this deployment'));
    }

    if (!config.batchLab.url) {
      return reply
        .status(503)
        .send(fail('BATCH_LAB_CONFIGURATION_ERROR', 'Batch Lab origin is not configured'));
    }

    if (!config.batchLab.source.configured) {
      return reply
        .status(503)
        .send(fail('BATCH_LAB_CONFIGURATION_ERROR', config.batchLab.source.reason));
    }

    try {
      await verifyBatchLabSourceConnection();
    } catch (err) {
      request.log.error({ err }, 'Batch Lab source connection verification failed');
      return reply
        .status(503)
        .send(fail('BATCH_LAB_SOURCE_UNAVAILABLE', 'Batch Lab source database is unavailable'));
    }

    const backendEnvironment: BatchLabContext['backend_environment'] = config.database.environment;

    return ok<BatchLabContext>({
      backend_environment: backendEnvironment,
      source_environment: config.batchLab.sourceEnvironment,
      capabilities: {
        sample_preview: true,
        experiment_execution: false,
      },
    });
  });

  // @frontend-ready: true — Batch Lab 样本 SQL 模板列表
  app.get('/api/batch-lab/sql-templates', async (_request, reply) => {
    const guard = await ensureBatchLabReady(reply);
    if (!guard) return;

    try {
      const repository = new BatchLabSampleRepository();
      return ok({ items: await repository.listTemplates() });
    } catch (err) {
      return sendBatchLabError(reply, err);
    }
  });

  // @frontend-ready: true - Batch Lab immutable postprocessor version list
  app.get('/api/batch-lab/processors', async (_request, reply) => {
    const guard = await ensureBatchLabReady(reply);
    if (!guard) return;

    try {
      const service = new BatchLabPostprocessingService();
      return ok({ items: await service.listProcessorVersions() });
    } catch (err) {
      return sendBatchLabError(reply, err);
    }
  });

  // @frontend-ready: true - Batch Lab creates a new immutable postprocessor version
  app.post('/api/batch-lab/processors', async (request, reply) => {
    const guard = await ensureBatchLabReady(reply);
    if (!guard) return;

    const parsed = batchLabCreateProcessorVersionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(fail('BATCH_LAB_PROCESSOR_VALIDATION_ERROR', 'Batch Lab processor is invalid'));
    }

    try {
      const service = new BatchLabPostprocessingService();
      return ok(await service.createProcessorVersion(parsed.data));
    } catch (err) {
      return sendBatchLabError(reply, err);
    }
  });

  // @frontend-ready: true - Batch Lab single-item postprocessing preview and display storage
  app.post('/api/batch-lab/processors/preview', async (request, reply) => {
    const guard = await ensureBatchLabReady(reply);
    if (!guard) return;

    const parsed = batchLabProcessorPreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          fail('BATCH_LAB_PROCESSOR_VALIDATION_ERROR', 'Batch Lab processor preview is invalid')
        );
    }

    try {
      const service = new BatchLabPostprocessingService();
      return ok(await service.preview(parsed.data));
    } catch (err) {
      return sendBatchLabError(reply, err);
    }
  });

  // @frontend-ready: true — Batch Lab 样本 SQL 预览并持久化短期 preview
  app.post('/api/batch-lab/sample-previews', async (request, reply) => {
    const guard = await ensureBatchLabReady(reply);
    if (!guard) return;

    const parsed = batchLabPreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(fail('BATCH_LAB_PROTOCOL_ERROR', 'Batch Lab preview request is invalid'));
    }
    if (parsed.data.source_environment !== config.batchLab.sourceEnvironment) {
      return reply
        .status(409)
        .send(fail('BATCH_LAB_ENVIRONMENT_MISMATCH', 'Batch Lab source environment mismatch'));
    }

    try {
      const service = new BatchLabSampleService();
      return ok(await service.createPreview(parsed.data));
    } catch (err) {
      request.log.error({ err }, 'Batch Lab sample preview failed');
      return sendBatchLabError(reply, err);
    }
  });

  // @frontend-ready: true — Batch Lab 冻结同一批 preview 为不可变样本集
  app.post('/api/batch-lab/sample-sets', async (request, reply) => {
    const guard = await ensureBatchLabReady(reply);
    if (!guard) return;

    const parsed = batchLabCreateSampleSetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(fail('BATCH_LAB_PROTOCOL_ERROR', 'Batch Lab sample set request is invalid'));
    }
    if (parsed.data.source_environment !== config.batchLab.sourceEnvironment) {
      return reply
        .status(409)
        .send(fail('BATCH_LAB_ENVIRONMENT_MISMATCH', 'Batch Lab source environment mismatch'));
    }

    try {
      const repository = new BatchLabSampleRepository();
      return ok(await repository.freezeSampleSet(parsed.data));
    } catch (err) {
      request.log.error({ err }, 'Batch Lab sample set freeze failed');
      return sendBatchLabError(reply, err);
    }
  });

  // @frontend-ready: true — Batch Lab 样本集列表摘要
  app.get('/api/batch-lab/sample-sets', async (_request, reply) => {
    const guard = await ensureBatchLabReady(reply);
    if (!guard) return;

    try {
      const repository = new BatchLabSampleRepository();
      return ok({ items: await repository.listSampleSets(), next_cursor: null });
    } catch (err) {
      return sendBatchLabError(reply, err);
    }
  });
}

async function ensureBatchLabReady(reply: FastifyReply): Promise<boolean> {
  if (!config.batchLab.enabled) {
    reply
      .status(503)
      .send(fail('BATCH_LAB_DISABLED', 'Batch Lab is not enabled for this deployment'));
    return false;
  }
  if (!config.batchLab.url) {
    reply
      .status(503)
      .send(fail('BATCH_LAB_CONFIGURATION_ERROR', 'Batch Lab origin is not configured'));
    return false;
  }
  const source = config.batchLab.source;
  if (!source.configured) {
    reply.status(503).send(fail('BATCH_LAB_CONFIGURATION_ERROR', source.reason));
    return false;
  }
  return true;
}

function sendBatchLabError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof BatchLabSourceQueryError || err instanceof BatchLabRepositoryError) {
    return reply
      .status(statusForBatchLabError(err.code))
      .send(fail(err.code, publicBatchLabMessage(err.code)));
  }
  return reply
    .status(503)
    .send(fail('BATCH_LAB_SOURCE_UNAVAILABLE', 'Batch Lab is temporarily unavailable'));
}

function publicBatchLabMessage(code: BatchLabErrorCode): string {
  if (code === 'BATCH_LAB_PROCESSOR_NOT_FOUND') return 'Batch Lab processor version was not found';
  if (code === 'BATCH_LAB_PROCESSOR_VALIDATION_ERROR')
    return 'Batch Lab processor config is invalid';
  if (code === 'BATCH_LAB_PROCESSOR_TIMEOUT') return 'Batch Lab processor timed out';
  if (code === 'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED')
    return 'Batch Lab processor output is too large';
  if (code === 'BATCH_LAB_PROCESSOR_RUNTIME_ERROR') return 'Batch Lab processor execution failed';
  if (code === 'BATCH_LAB_INVALID_SQL') return 'Batch Lab SQL is invalid';
  if (code === 'BATCH_LAB_TIMEOUT') return 'Batch Lab request timed out';
  if (code === 'BATCH_LAB_CAPACITY_EXCEEDED') return 'Batch Lab request exceeds capacity limits';
  if (code === 'BATCH_LAB_EMPTY_PREVIEW') return 'Batch Lab preview has no valid samples';
  if (code === 'BATCH_LAB_ENVIRONMENT_MISMATCH') return 'Batch Lab source environment mismatch';
  if (
    code === 'BATCH_LAB_PREVIEW_NOT_FOUND' ||
    code === 'BATCH_LAB_PREVIEW_EXPIRED' ||
    code === 'BATCH_LAB_PREVIEW_MISMATCH'
  ) {
    return 'Batch Lab preview is no longer available';
  }
  if (code === 'BATCH_LAB_IDEMPOTENCY_CONFLICT') return 'Batch Lab idempotency key conflicts';
  return 'Batch Lab is temporarily unavailable';
}

function statusForBatchLabError(code: BatchLabErrorCode): number {
  if (code === 'BATCH_LAB_TIMEOUT' || code === 'BATCH_LAB_PROCESSOR_TIMEOUT') return 504;
  if (code === 'BATCH_LAB_INVALID_SQL' || code === 'BATCH_LAB_EMPTY_PREVIEW') return 422;
  if (
    code === 'BATCH_LAB_PROCESSOR_VALIDATION_ERROR' ||
    code === 'BATCH_LAB_PROCESSOR_RUNTIME_ERROR'
  ) {
    return 422;
  }
  if (code === 'BATCH_LAB_CAPACITY_EXCEEDED' || code === 'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED') {
    return 413;
  }
  if (code === 'BATCH_LAB_PROCESSOR_NOT_FOUND') return 404;
  if (
    code === 'BATCH_LAB_PREVIEW_NOT_FOUND' ||
    code === 'BATCH_LAB_PREVIEW_EXPIRED' ||
    code === 'BATCH_LAB_PREVIEW_MISMATCH' ||
    code === 'BATCH_LAB_IDEMPOTENCY_CONFLICT' ||
    code === 'BATCH_LAB_ENVIRONMENT_MISMATCH'
  ) {
    return 409;
  }
  if (code === 'BATCH_LAB_PROTOCOL_ERROR') return 502;
  return 503;
}
