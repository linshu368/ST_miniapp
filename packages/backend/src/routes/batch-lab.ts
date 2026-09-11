import type { FastifyInstance } from 'fastify';
import { fail, ok, type BatchLabContext } from '@miniapp/shared';
import { verifyBatchLabSourceConnection } from '../features/batch-lab/source-database.js';
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
        sample_preview: false,
        experiment_execution: false,
      },
    });
  });
}
