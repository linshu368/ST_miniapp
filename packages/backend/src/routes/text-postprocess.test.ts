import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdminActor: vi.fn(),
  readVersions: vi.fn(),
  readAdminState: vi.fn(),
  readRequest: vi.fn(),
  saveDraft: vi.fn(),
  publish: vi.fn(),
  rollback: vi.fn(),
  discard: vi.fn(),
}));

vi.mock('../features/admin-access/session.js', () => {
  class AdminSessionError extends Error {
    constructor(
      readonly statusCode: 401 | 403,
      message: string
    ) {
      super(message);
      this.name = 'AdminSessionError';
    }
  }
  return { AdminSessionError, requireAdminActor: mocks.requireAdminActor };
});

vi.mock('../features/text-postprocess/service.js', () => ({
  readTextPostprocessVersions: mocks.readVersions,
  readTextPostprocessAdminState: mocks.readAdminState,
  readTextPostprocessRequest: mocks.readRequest,
  saveTextPostprocessDraft: mocks.saveDraft,
  publishTextPostprocess: mocks.publish,
  rollbackTextPostprocess: mocks.rollback,
  discardTextPostprocessDraft: mocks.discard,
}));

import textPostprocessRoutes from './text-postprocess.js';

const lines: string[] = [];

async function buildApp() {
  lines.length = 0;
  const app = Fastify({
    logger: {
      level: 'info',
      stream: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    },
  });
  await app.register(textPostprocessRoutes);
  await app.ready();
  return app;
}

describe('text postprocess routes', () => {
  beforeEach(() => {
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    mocks.requireAdminActor.mockReset();
    mocks.readVersions.mockReset();
    mocks.saveDraft.mockReset();
    mocks.publish.mockReset();
    mocks.requireAdminActor.mockResolvedValue({
      userId: '00000000-0000-4000-8000-0000000000a1',
      role: 'owner',
    });
  });

  it('rejects an anonymous admin call and a viewer write', async () => {
    const { AdminSessionError } = await import('../features/admin-access/session.js');
    mocks.requireAdminActor.mockRejectedValueOnce(
      new AdminSessionError(401, 'Admin session is required')
    );
    const app = await buildApp();
    const missing = await app.inject({ method: 'GET', url: '/api/admin/text-postprocess' });
    expect(missing.statusCode).toBe(401);
    mocks.requireAdminActor.mockRejectedValueOnce(
      new AdminSessionError(403, 'Operator access is required')
    );
    const denied = await app.inject({
      method: 'POST',
      url: '/api/admin/text-postprocess/publish',
      headers: { authorization: 'Bearer SECRET_TOKEN' },
      payload: { request_id: '00000000-0000-4000-8000-000000000101' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(lines.join('\n')).not.toContain('SECRET_TOKEN');
    await app.close();
  });

  it('returns draft diagnostics and does not call the save RPC for a bad source', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/text-postprocess/draft',
      headers: { authorization: 'Bearer SECRET_TOKEN' },
      payload: {
        request_id: '00000000-0000-4000-8000-000000000101',
        expected_runtime_version: null,
        expected_draft_updated_at: null,
        expected_draft_digest: null,
        source: { schema_version: 1, policy_version: 1, rules: [], extra: true },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'invalid_draft' },
    });
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain('SECRET_TOKEN');
    await app.close();
  });

  it('returns found and unavailable versions for an authenticated miniapp request', async () => {
    mocks.readVersions.mockResolvedValue({
      found: [],
      unavailable_versions: [9],
    });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/text-postprocess/versions',
      payload: { versions: [9] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: { unavailable_versions: [9] },
    });
    await app.close();
  });
  it('returns the minimal artifact contract and logs counts without the artifact body', async () => {
    const snapshot = {
      version: 2,
      artifact: { schema_version: 1, policy_version: 1, rules: [] },
      published_at: '2026-09-28T00:00:00.000Z',
    };
    mocks.readVersions.mockResolvedValue({ found: [snapshot], unavailable_versions: [9] });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/text-postprocess/versions',
      payload: { versions: [2, 9] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ found: [snapshot], unavailable_versions: [9] });
    expect(response.json().data.found[0]).not.toHaveProperty('source');
    expect(lines.join('\n')).not.toContain('schema_version');
    await app.close();
  });
});
