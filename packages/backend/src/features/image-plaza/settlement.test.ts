import { Buffer } from 'node:buffer';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ImagePlazaRepository, type ImagePlazaWorkerAttempt } from './repository.js';
import { startImagePlazaGenerationJob, stopImagePlazaGenerationJob } from './job.js';
import type { StoredPlazaImage } from './storage.js';

type RpcResult = {
  data: { status?: string; ledger_id?: string } | null;
  error: { message: string } | null;
};
const mocks = vi.hoisted(() => ({
  rpc: vi.fn<(...args: unknown[]) => Promise<RpcResult>>(),
  upload: vi.fn<(...args: unknown[]) => Promise<StoredPlazaImage>>(),
  remove: vi.fn<(path: string) => Promise<void>>(),
  venice: vi.fn<typeof fetch>(),
  updates: [] as Record<string, unknown>[],
  filters: [] as unknown[][],
  status: 'generating',
}));
vi.mock('../../platform/config.js', () => ({
  config: {
    imagePlaza: {
      workerEnabled: true,
      workerIntervalMs: 1000,
      workerLeaseSeconds: 180,
      apiKey: 'virtual-fixture-only',
      baseUrl: 'https://fixture.invalid/api/v1',
      timeoutMs: 2000,
    },
  },
}));
vi.mock('../../lib/supabase.js', () => {
  const getDomainDb = () => ({
    rpc: mocks.rpc,
    from: () => {
      let changes: Record<string, unknown> = {};
      let matches = true;
      const query = {
        update(value: Record<string, unknown>) {
          changes = value;
          mocks.updates.push(value);
          return query;
        },
        eq(column: string, value: unknown) {
          mocks.filters.push(['eq', column, value]);
          matches &&= column === 'id' ? value === attempt.id : value === mocks.status;
          return query;
        },
        in(column: string, values: unknown[]) {
          mocks.filters.push(['in', column, values]);
          matches &&= values.includes(mocks.status);
          return query;
        },
        then(
          resolve: (value: { data: null; error: null }) => unknown,
          reject: (reason: unknown) => unknown
        ) {
          // Only emulate conditional row updates; no settlement/ledger algorithm is reimplemented.
          if (matches && typeof changes.status === 'string') mocks.status = changes.status;
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  });
  return { getDomainDb };
});
vi.mock('./storage.js', () => ({
  uploadPlazaImage: mocks.upload,
  deletePlazaImage: mocks.remove,
  downloadPlazaImage: vi.fn(),
  signPlazaImagePath: vi.fn(),
}));
vi.mock('../../platform/venice-http.js', () => ({ veniceFetch: mocks.venice }));

const attempt: ImagePlazaWorkerAttempt = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  prompt: 'virtual cup fixture',
  providerModelId: 'fixture-model',
  editProviderModelId: null,
  sizingMode: 'aspect_ratio',
  mode: 't2i',
  aspectRatio: '1:1',
  resolution: '1K',
  autoOptimize: false,
  referenceArtifactId: null,
};
/** 大于上游过小图阈值，避免 worker 在结算前误判 content_rejected。 */
const bytes = Buffer.alloc(5 * 1024, 9);
const stored: StoredPlazaImage = {
  storagePath: `image-plaza/${attempt.userId}/attempts/${attempt.id}/0.webp`,
  mimeType: 'image/webp',
  byteSize: bytes.length,
  width: 512,
  height: 512,
};
let claim: MockInstance<ImagePlazaRepository['claimJobs']>;
let markFailed: MockInstance<ImagePlazaRepository['markFailed']>;
let noNetwork: ReturnType<typeof vi.fn<typeof fetch>>;
let log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.updates = [];
  mocks.filters = [];
  mocks.status = 'generating';
  mocks.upload.mockResolvedValue(stored);
  mocks.remove.mockResolvedValue(undefined);
  mocks.rpc.mockResolvedValue({
    data: { status: 'settled', ledger_id: 'virtual-ledger' },
    error: null,
  });
  mocks.venice.mockResolvedValue(
    Response.json({ id: 'virtual-provider-request', images: [bytes.toString('base64')] })
  );
  noNetwork = vi.fn<typeof fetch>().mockRejectedValue(new Error('NETWORK_DISABLED'));
  vi.stubGlobal('fetch', noNetwork);
  claim = vi.spyOn(ImagePlazaRepository.prototype, 'claimJobs').mockResolvedValue([]);
  vi.spyOn(ImagePlazaRepository.prototype, 'markStaleDispatchedUnknown').mockResolvedValue(
    undefined
  );
  vi.spyOn(ImagePlazaRepository.prototype, 'markGenerating').mockResolvedValue(undefined);
  vi.spyOn(ImagePlazaRepository.prototype, 'recordProviderRequestId').mockResolvedValue(undefined);
  markFailed = vi.spyOn(ImagePlazaRepository.prototype, 'markFailed');
  log = { info: vi.fn(), error: vi.fn() };
});
afterEach(async () => {
  stopImagePlazaGenerationJob();
  await vi.advanceTimersByTimeAsync(0);
  expect(noNetwork).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const settle = () =>
  new ImagePlazaRepository().settleGeneratedImage({ attempt, bytes, mimeType: 'image/webp' });
const unknownFailure = {
  name: 'ImagePlazaSettlementError',
  code: 'image_plaza_settlement_outcome_unknown',
  outcomeUnknown: true,
};
const balanceFailure = {
  name: 'ImagePlazaSettlementError',
  code: 'image_plaza_insufficient_balance',
  outcomeUnknown: false,
};
async function runWorker() {
  claim.mockResolvedValueOnce([attempt]);
  startImagePlazaGenerationJob(log as unknown as FastifyBaseLogger);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5000);
  stopImagePlazaGenerationJob();
}
function expectNotReady() {
  expect(log.info).not.toHaveBeenCalled();
  expect(mocks.venice).toHaveBeenCalledTimes(1);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
}

describe('image plaza settlement boundaries', () => {
  it('never calls settlement when image storage fails', async () => {
    mocks.upload.mockRejectedValue(new Error('virtual storage failed'));
    await expect(settle()).rejects.toThrow('virtual storage failed');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
  });
  it('stores first and settles once with exact owner, attempt and artifact fields', async () => {
    await settle();
    expect(mocks.upload).toHaveBeenCalledExactlyOnceWith({
      userId: attempt.userId,
      namespace: 'attempts',
      ownerId: attempt.id,
      position: 0,
      bytes,
      declaredMimeType: 'image/webp',
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('settle_image_plaza_generation', {
      p_attempt_id: attempt.id,
      p_user_id: attempt.userId,
      p_artifacts: [
        {
          position: 0,
          storage_path: stored.storagePath,
          mime_type: stored.mimeType,
          byte_size: stored.byteSize,
          width: stored.width,
          height: stored.height,
        },
      ],
    });
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rpc.mock.invocationCallOrder[0]!
    );
    expect(mocks.updates).toEqual([{ status: 'storing', updated_at: expect.any(String) }]);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('accepts an already_settled response without deleting the artifact', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'already_settled' }, error: null });
    await settle();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it.each([
    { label: 'RPC error', result: { data: null, error: { message: 'virtual RPC error' } } },
    {
      label: 'error with misleading insufficient balance data',
      result: { data: { status: 'insufficient_balance' }, error: { message: 'virtual RPC error' } },
    },
    {
      label: 'error with misleading settled data',
      result: { data: { status: 'settled' }, error: { message: 'virtual RPC error' } },
    },
    { label: 'missing response', result: { data: null, error: null } },
    { label: 'unrecognized status', result: { data: { status: 'unexpected' }, error: null } },
  ])('preserves the stored image on $label without retrying settlement', async ({ result }) => {
    mocks.rpc.mockResolvedValue(result);
    await expect(settle()).rejects.toMatchObject(unknownFailure);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('preserves the image when the RPC promise rejects', async () => {
    const cause = new Error('virtual response lost');
    mocks.rpc.mockRejectedValue(cause);
    await expect(settle()).rejects.toMatchObject({ ...unknownFailure, cause });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'throws a definite balance failure even when cleanup failure is %s',
    async (cleanupFails) => {
      mocks.rpc.mockResolvedValue({ data: { status: 'insufficient_balance' }, error: null });
      if (cleanupFails) mocks.remove.mockRejectedValue(new Error('virtual cleanup failed'));
      await expect(settle()).rejects.toMatchObject(balanceFailure);
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(stored.storagePath);
    }
  );
  it('keeps the existing conditional failure update from overwriting ready', async () => {
    mocks.status = 'ready';
    await new ImagePlazaRepository().markFailed(attempt.id, unknownFailure.code, true);
    expect(mocks.filters).toEqual([
      ['eq', 'id', attempt.id],
      ['in', 'status', ['leased', 'generating', 'storing']],
    ]);
    expect(mocks.status).toBe('ready');
  });
});

describe('image plaza worker orchestration', () => {
  it('runs real provider parsing and settlement once for one claimed attempt', async () => {
    await runWorker();
    expect(mocks.venice).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(mocks.venice.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: attempt.providerModelId,
      prompt: attempt.prompt,
      enhance_prompt: false,
      aspect_ratio: '1:1',
      variants: 1,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(markFailed).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });
  it.each([
    { label: 'provider rejection', code: 'image_plaza_provider_http_429', unknown: false },
    {
      label: 'transport outcome unknown',
      code: 'image_plaza_provider_outcome_unknown',
      unknown: true,
    },
    {
      label: 'unreadable successful response',
      code: 'image_plaza_provider_outcome_unknown',
      unknown: true,
    },
  ])(
    'does not resubmit $label and records the right failure outcome',
    async ({ label, code, unknown }) => {
      if (label === 'provider rejection')
        mocks.venice.mockResolvedValue(new Response('', { status: 429 }));
      else if (label === 'transport outcome unknown')
        mocks.venice.mockRejectedValue(new Error('virtual transport loss'));
      else mocks.venice.mockResolvedValue(new Response('invalid JSON', { status: 200 }));
      await runWorker();
      expect(mocks.venice).toHaveBeenCalledTimes(1);
      expect(markFailed).toHaveBeenCalledExactlyOnceWith(attempt.id, code, unknown);
      expect(mocks.status).toBe(unknown ? 'failed_unknown' : 'failed');
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
    }
  );
  it('does not settle or charge when Venice marks a content violation', async () => {
    mocks.venice.mockResolvedValue(
      new Response(JSON.stringify({ id: 'viol', images: [bytes.toString('base64')] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-venice-is-content-violation': 'true',
        },
      })
    );
    await runWorker();
    expect(mocks.venice).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledExactlyOnceWith(
      attempt.id,
      'image_plaza_provider_content_rejected',
      false
    );
    expect(mocks.status).toBe('failed');
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not settle when worker storage fails after provider success', async () => {
    mocks.upload.mockRejectedValue(new Error('virtual storage failed'));
    await runWorker();
    expect(mocks.venice).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledExactlyOnceWith(
      attempt.id,
      'image_plaza_generation_failed',
      false
    );
    expect(log.info).not.toHaveBeenCalled();
  });
  it.each(['returned error', 'rejected promise', 'error with balance data', 'missing status'])(
    'preserves artifacts and marks settlement unknown for %s without resubmitting',
    async (mode) => {
      if (mode === 'rejected promise')
        mocks.rpc.mockRejectedValue(new Error('virtual response lost'));
      else
        mocks.rpc.mockResolvedValue({
          data: mode === 'error with balance data' ? { status: 'insufficient_balance' } : null,
          error: mode === 'missing status' ? null : { message: 'virtual RPC error' },
        });
      await runWorker();
      expect(markFailed).toHaveBeenCalledExactlyOnceWith(attempt.id, unknownFailure.code, true);
      expect(mocks.status).toBe('failed_unknown');
      expect(mocks.remove).not.toHaveBeenCalled();
      expectNotReady();
    }
  );
  it('does not overwrite an already-ready row when a committed response was lost', async () => {
    mocks.rpc.mockImplementation(async () => {
      // A pre-existing row state fixture, not a simulation of the database transaction.
      mocks.status = 'ready';
      throw new Error('virtual committed response lost');
    });
    await runWorker();
    expect(mocks.status).toBe('ready');
    expect(markFailed).toHaveBeenCalledExactlyOnceWith(attempt.id, unknownFailure.code, true);
    expect(mocks.remove).not.toHaveBeenCalled();
    expectNotReady();
  });
  it.each([false, true])(
    'does not log ready on insufficient balance with cleanup failure %s',
    async (cleanupFails) => {
      mocks.rpc.mockResolvedValue({ data: { status: 'insufficient_balance' }, error: null });
      if (cleanupFails) mocks.remove.mockRejectedValue(new Error('virtual cleanup failed'));
      await runWorker();
      expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(stored.storagePath);
      expect(markFailed).toHaveBeenCalledExactlyOnceWith(attempt.id, balanceFailure.code, false);
      expect(mocks.status).toBe('failed');
      expectNotReady();
    }
  );
});
