import { describe, expect, it } from 'vitest';
import {
  TEXT_POSTPROCESS_POLICY_VERSION,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  type PublishTextPostprocessRequest,
  type TextPostprocessAdminState,
} from '@miniapp/shared';
import {
  TEXT_POSTPROCESS_RESULT_UNKNOWN,
  TEXT_POSTPROCESS_VALIDATION_UNAVAILABLE,
  TextPostprocessClientError,
  createTextPostprocessApi,
  textPostprocessApiUrl,
} from './textPostprocessApi';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const DIGEST = 'a'.repeat(64);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function publishBody(): PublishTextPostprocessRequest {
  return {
    request_id: REQUEST_ID,
    expected_runtime_version: 2,
    expected_draft_updated_at: '2026-09-28T01:00:00.000Z',
    expected_draft_digest: DIGEST,
    draft_revision: 'draft-1',
  };
}

function adminState(): TextPostprocessAdminState {
  return {
    runtime_version: 2,
    published: {
      version: 2,
      schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
      policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
      source: {
        schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
        policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
        rules: [],
      },
      published_at: '2026-09-28T00:00:00.000Z',
    },
    draft: null,
    history: [],
    has_more: false,
  };
}

describe('text postprocess admin api', () => {
  it('sends the bearer token to the selected environment and validates the response', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const api = createTextPostprocessApi({
      environment: 'test',
      baseUrl: 'https://test.example/',
      getAccessToken: async () => 'test-token',
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('Authorization'),
        });
        const url = String(input);
        if (url.includes('/requests/')) {
          return jsonResponse(200, { success: true, data: { outcome: null } });
        }
        return jsonResponse(200, { success: true, data: adminState() });
      },
    });

    const state = await api.readState({ beforeVersion: 4 });
    expect(state.runtime_version).toBe(2);
    expect(calls[0]).toEqual({
      url: 'https://test.example/api/admin/text-postprocess?limit=20&before_version=4',
      authorization: 'Bearer test-token',
    });
    await api.lookup(REQUEST_ID);
    expect(calls[1]?.url).toBe(
      `https://test.example/api/admin/text-postprocess/requests/${REQUEST_ID}`
    );
    expect(calls[1]?.authorization).toBe('Bearer test-token');
  });

  it('keeps production and test requests on their own API origin and token', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push(`${new Headers(init?.headers).get('Authorization')}|${String(input)}`);
      return jsonResponse(200, { success: true, data: adminState() });
    };
    const testApi = createTextPostprocessApi({
      environment: 'test',
      baseUrl: 'https://test.example',
      getAccessToken: async () => 'test-token',
      fetchImpl,
    });
    const productionApi = createTextPostprocessApi({
      environment: 'production',
      baseUrl: 'https://prod.example',
      getAccessToken: async () => 'prod-token',
      fetchImpl,
    });
    await testApi.readState();
    await productionApi.readState();
    expect(seen).toEqual([
      'Bearer test-token|https://test.example/api/admin/text-postprocess?limit=20',
      'Bearer prod-token|https://prod.example/api/admin/text-postprocess?limit=20',
    ]);
  });

  it('rejects a response that does not match the shared schema', async () => {
    const api = createTextPostprocessApi({
      environment: 'test',
      baseUrl: 'https://test.example',
      getAccessToken: async () => 'test-token',
      fetchImpl: async () => jsonResponse(200, { success: true, data: { extra: true } }),
    });
    await expect(api.readState()).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('classifies validation unavailable separately from field diagnostics', async () => {
    const api = createTextPostprocessApi({
      environment: 'production',
      baseUrl: 'https://prod.example',
      getAccessToken: async () => 'prod-token',
      fetchImpl: async () =>
        jsonResponse(503, {
          success: false,
          error: {
            code: TEXT_POSTPROCESS_VALIDATION_UNAVAILABLE,
            message: 'Text postprocess validation is unavailable.',
          },
        }),
    });
    const error = await api.publish(publishBody()).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(TextPostprocessClientError);
    expect(error).toMatchObject({
      kind: 'validation_unavailable',
      code: 'VALIDATION_UNAVAILABLE',
      diagnostics: [],
    });
    expect((error as TextPostprocessClientError).message).not.toContain('prod-token');
  });

  it('treats an unknown write result as result unknown and does not describe it as a field error', async () => {
    const api = createTextPostprocessApi({
      environment: 'test',
      baseUrl: 'https://test.example',
      getAccessToken: async () => 'test-token',
      fetchImpl: async () =>
        jsonResponse(503, {
          success: false,
          error: {
            code: TEXT_POSTPROCESS_RESULT_UNKNOWN,
            message: 'The result was not confirmed. Retry the same request id.',
          },
        }),
    });
    await expect(api.publish(publishBody())).rejects.toMatchObject({
      kind: 'result_unknown',
      code: 'RESULT_UNKNOWN',
    });
  });

  it('keeps compile diagnostics on the mutation error', async () => {
    const api = createTextPostprocessApi({
      environment: 'test',
      baseUrl: 'https://test.example',
      getAccessToken: async () => 'test-token',
      fetchImpl: async () =>
        jsonResponse(400, {
          success: false,
          error: {
            code: 'compile_rejected',
            message: 'The text postprocess source failed validation.',
            diagnostics: [
              {
                code: 'INVALID_PATTERN',
                rule_id: 'highlight',
                field: 'pattern',
                message: 'Pattern is not a supported regular expression.',
                location: null,
              },
            ],
          },
        }),
    });
    await expect(api.publish(publishBody())).rejects.toMatchObject({
      kind: 'mutation',
      code: 'compile_rejected',
      diagnostics: [expect.objectContaining({ field: 'pattern', rule_id: 'highlight' })],
    });
  });

  it('does not send a publish body that fails the shared schema', async () => {
    let called = false;
    const api = createTextPostprocessApi({
      environment: 'test',
      baseUrl: 'https://test.example',
      getAccessToken: async () => 'test-token',
      fetchImpl: async () => {
        called = true;
        return jsonResponse(200, { success: true, data: { action: 'publish', replayed: false } });
      },
    });
    await expect(api.publish({ ...publishBody(), draft_revision: '' })).rejects.toMatchObject({
      kind: 'mutation',
    });
    expect(called).toBe(false);
  });

  it('turns a dropped write response into result unknown', async () => {
    const api = createTextPostprocessApi({
      environment: 'test',
      baseUrl: 'https://test.example',
      getAccessToken: async () => 'test-token',
      timeoutMs: 20,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });
    await expect(api.publish(publishBody())).rejects.toMatchObject({ kind: 'result_unknown' });
  });

  it('does not turn a dropped read into a mutation result', async () => {
    const api = createTextPostprocessApi({
      environment: 'test',
      baseUrl: 'https://test.example',
      getAccessToken: async () => 'test-token',
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    await expect(api.readState()).rejects.toMatchObject({ kind: 'transport' });
  });

  it('builds the environment API url without mixing origins', () => {
    expect(
      textPostprocessApiUrl('test', '/api/admin/text-postprocess', 'https://test.example')
    ).toBe('https://test.example/api/admin/text-postprocess');
    expect(
      textPostprocessApiUrl('production', '/api/admin/text-postprocess', 'https://prod.example/')
    ).toBe('https://prod.example/api/admin/text-postprocess');
  });
});
