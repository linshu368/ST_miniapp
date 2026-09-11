import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedConfig = vi.hoisted(() => ({
  batchLab: { enabled: false, url: '', sourceEnvironment: 'test' as const },
  database: { environment: 'test' as 'development' | 'test' | 'production' },
}));

vi.mock('../platform/config.js', () => ({ config: mockedConfig }));

import batchLabRoutes from './batch-lab.js';

describe('Batch Lab context route', () => {
  beforeEach(() => {
    mockedConfig.batchLab.enabled = false;
    mockedConfig.batchLab.url = '';
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

  it('returns authoritative environments without credentials', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    const app = Fastify();
    await app.register(batchLabRoutes);
    const response = await app.inject({ method: 'GET', url: '/api/batch-lab/context' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        backend_environment: 'test',
        source_environment: 'test',
        capabilities: { sample_preview: false, experiment_execution: false },
      },
    });
    await app.close();
  });

  it('uses the database environment rather than NODE_ENV deployment mode', async () => {
    mockedConfig.batchLab.enabled = true;
    mockedConfig.batchLab.url = 'https://batch-lab.example.com';
    mockedConfig.database.environment = 'development';
    const app = Fastify();
    await app.register(batchLabRoutes);
    const response = await app.inject({ method: 'GET', url: '/api/batch-lab/context' });
    expect(response.json().data.backend_environment).toBe('development');
    mockedConfig.database.environment = 'test';
    await app.close();
  });
});
