import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedConfig = vi.hoisted(() => ({
  batchLab: {
    enabled: false,
    url: '',
    sourceEnvironment: 'test' as const,
    source: { configured: false as boolean, reason: 'not configured' },
  },
  database: { environment: 'test' as 'development' | 'test' | 'production' },
}));

vi.mock('../platform/config.js', () => ({ config: mockedConfig }));
const verifyBatchLabSourceConnection = vi.hoisted(() => vi.fn());
vi.mock('../features/batch-lab/source-database.js', () => ({ verifyBatchLabSourceConnection }));
const createPreview = vi.hoisted(() => vi.fn());
vi.mock('../features/batch-lab/sample-service.js', () => ({
  BatchLabSampleService: vi.fn().mockImplementation(function BatchLabSampleServiceMock() {
    return { createPreview };
  }),
}));
const postprocessingMethods = vi.hoisted(() => ({
  listProcessorVersions: vi.fn(),
  createProcessorVersion: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('../features/batch-lab/postprocessing-service.js', () => ({
  BatchLabPostprocessingService: vi
    .fn()
    .mockImplementation(function BatchLabPostprocessingServiceMock() {
      return postprocessingMethods;
    }),
}));
const repositoryMethods = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  freezeSampleSet: vi.fn(),
  listSampleSets: vi.fn(),
}));
vi.mock('../infrastructure/repositories/BatchLabSampleRepository.js', () => ({
  BatchLabRepositoryError: class BatchLabRepositoryError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
    }
  },
  BatchLabSampleRepository: vi.fn().mockImplementation(function BatchLabSampleRepositoryMock() {
    return repositoryMethods;
  }),
}));

import batchLabRoutes from './batch-lab.js';
import { BatchLabRepositoryError } from '../infrastructure/repositories/BatchLabSampleRepository.js';

describe('Batch Lab routes', () => {
  beforeEach(() => {
    mockedConfig.batchLab.enabled = false;
    mockedConfig.batchLab.url = '';
    mockedConfig.batchLab.source = { configured: false, reason: 'not configured' };
    verifyBatchLabSourceConnection.mockReset();
    verifyBatchLabSourceConnection.mockResolvedValue(undefined);
    createPreview.mockReset();
    postprocessingMethods.listProcessorVersions.mockReset();
    postprocessingMethods.createProcessorVersion.mockReset();
    postprocessingMethods.preview.mockReset();
    repositoryMethods.listTemplates.mockReset();
    repositoryMethods.freezeSampleSet.mockReset();
    repositoryMethods.listSampleSets.mockReset();
  });

  it('fails closed when the feature is disabled', async () => {
    const app = Fastify();
    await app.register(batchLabRoutes);
    const response = await app.inject({ method: 'GET', url: '/api/batch-lab/context' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'BATCH_LAB_DISABLED' },
    });
    await app.close();
  });

  it('fails closed when the dedicated source connection is not configured', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    const app = Fastify();
    await app.register(batchLabRoutes);
    const response = await app.inject({ method: 'GET', url: '/api/batch-lab/context' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'BATCH_LAB_CONFIGURATION_ERROR' },
    });
    await app.close();
  });

  it('returns authoritative environments when all static guards pass', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    mockedConfig.batchLab.source = { configured: true, reason: '' };
    const app = Fastify();
    await app.register(batchLabRoutes);
    const response = await app.inject({ method: 'GET', url: '/api/batch-lab/context' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        backend_environment: 'test',
        source_environment: 'test',
        capabilities: { sample_preview: true, experiment_execution: false },
      },
    });
    await app.close();
  });

  it('fails closed when the source identity probe fails', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    mockedConfig.batchLab.source = { configured: true, reason: '' };
    verifyBatchLabSourceConnection.mockRejectedValue(new Error('connection failed'));
    const app = Fastify({ logger: false });
    await app.register(batchLabRoutes);
    const response = await app.inject({ method: 'GET', url: '/api/batch-lab/context' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'BATCH_LAB_SOURCE_UNAVAILABLE' },
    });
    expect(response.body).not.toContain('connection failed');
    await app.close();
  });

  it('uses the database environment rather than NODE_ENV deployment mode', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    mockedConfig.batchLab.source = { configured: true, reason: '' };
    mockedConfig.database.environment = 'development';
    const app = Fastify();
    await app.register(batchLabRoutes);
    const response = await app.inject({ method: 'GET', url: '/api/batch-lab/context' });
    expect(response.json().data.backend_environment).toBe('development');
    mockedConfig.database.environment = 'test';
    await app.close();
  });

  it('rejects preview requests for a different source environment', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    mockedConfig.batchLab.source = { configured: true, reason: '' };
    const app = Fastify();
    await app.register(batchLabRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/batch-lab/sample-previews',
      payload: {
        source_environment: 'production',
        template_key: null,
        template_version: null,
        sql: 'select id as source_history_id from experience.chat_history',
        parameters: {},
        sample_limit: 1,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'BATCH_LAB_ENVIRONMENT_MISMATCH' },
    });
    expect(createPreview).not.toHaveBeenCalled();
    await app.close();
  });

  it('creates a preview through the service without leaking raw errors', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    mockedConfig.batchLab.source = { configured: true, reason: '' };
    createPreview.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      digest: `sha256:${'a'.repeat(64)}`,
      source_environment: 'test',
      final_sql: 'select id as source_history_id from experience.chat_history',
      parameters: {},
      sample_limit: 1,
      statistics: {
        requested_count: 1,
        candidate_count: 1,
        valid_count: 1,
        user_count: 1,
        session_count: 1,
        character_count: 1,
        excluded_by_reason: {},
        truncated: false,
        snapshot_bytes: 128,
      },
      items: [],
      created_at: '2026-09-11T06:00:00.000Z',
      expires_at: '2026-09-11T06:15:00.000Z',
    });
    const app = Fastify();
    await app.register(batchLabRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/batch-lab/sample-previews',
      payload: {
        source_environment: 'test',
        template_key: null,
        template_version: null,
        sql: 'select id as source_history_id from experience.chat_history',
        parameters: {},
        sample_limit: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(createPreview).toHaveBeenCalledOnce();
    await app.close();
  });

  it('lists processor versions through the postprocessing service', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    mockedConfig.batchLab.source = { configured: true, reason: '' };
    postprocessingMethods.listProcessorVersions.mockResolvedValue([
      {
        id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        name: 'No postprocessing',
        protocol: 'none_v1',
        config: { protocol: 'none_v1' },
        digest: `sha256:${'a'.repeat(64)}`,
        created_at: '2026-09-11T06:00:00.000Z',
      },
    ]);
    const app = Fastify();
    await app.register(batchLabRoutes);

    const response = await app.inject({ method: 'GET', url: '/api/batch-lab/processors' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(1);
    expect(postprocessingMethods.listProcessorVersions).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects processor previews that provide both id and inline config', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    mockedConfig.batchLab.source = { configured: true, reason: '' };
    const app = Fastify();
    await app.register(batchLabRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/batch-lab/processors/preview',
      payload: {
        processor_version_id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        config: { protocol: 'none_v1' },
        input_text: 'hello',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'BATCH_LAB_PROCESSOR_VALIDATION_ERROR' },
    });
    expect(postprocessingMethods.preview).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps processor timeout errors to gateway timeout without leaking details', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    mockedConfig.batchLab.source = { configured: true, reason: '' };
    postprocessingMethods.preview.mockRejectedValue(
      new BatchLabRepositoryError('BATCH_LAB_PROCESSOR_TIMEOUT', 'regex internals')
    );
    const app = Fastify();
    await app.register(batchLabRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/batch-lab/processors/preview',
      payload: { config: { protocol: 'none_v1' }, input_text: 'hello' },
    });

    expect(response.statusCode).toBe(504);
    expect(response.body).not.toContain('regex internals');
    await app.close();
  });
});
