import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryJob } from './video-delivery-repository.js';
import type { VideoAttemptRow } from './video-repository.js';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  attempt: vi.fn(),
  checkpoint: vi.fn(),
  saveSession: vi.fn(),
  release: vi.fn(),
  fail: vi.fn(),
  publish: vi.fn(),
  failedAssets: vi.fn(),
  prune: vi.fn(),
  cleaned: vi.fn(),
  retrieve: vi.fn(),
  download: vi.fn(),
  create: vi.fn(),
  chunk: vi.fn(),
  finish: vi.fn(),
  verify: vi.fn(),
  poster: vi.fn(),
  complete: vi.fn(),
}));
vi.mock('../../platform/config.js', () => ({
  config: { imagePlaza: { videoWorkerEnabled: true } },
}));
vi.mock('../../platform/observability/runtime.js', () => ({
  observation: {
    start: () => ({ finish: mocks.finish }),
    observe: async (_name: string, run: () => Promise<unknown>) => run(),
  },
}));
vi.mock('../../platform/observability/jobs.js', () => ({
  runObservedJob: async (_name: string, run: () => Promise<void>) => run(),
  finishBackgroundOperation: vi.fn(),
}));
vi.mock('../../platform/observability/context.js', () => ({
  withBusinessContext: async (_fields: unknown, run: () => Promise<void>) => run(),
}));
vi.mock('./video-delivery-repository.js', () => ({
  VideoDeliveryRepository: class {
    claim = mocks.claim;
    attempt = mocks.attempt;
    checkpoint = mocks.checkpoint;
    saveSession = mocks.saveSession;
    release = mocks.release;
    fail = mocks.fail;
    publish = mocks.publish;
    failedAssets = mocks.failedAssets;
    prune = mocks.prune;
    cleaned = mocks.cleaned;
  },
}));
vi.mock('./video-stream-upload.js', () => ({
  createStreamUpload: mocks.create,
  uploadStreamChunk: mocks.chunk,
}));
vi.mock('./video-upstream.js', () => ({
  retrieveVideo: mocks.retrieve,
  downloadVideo: mocks.download,
  completeVideo: mocks.complete,
}));
vi.mock('./video-stream-playback.js', () => ({
  verifyStreamReady: mocks.verify,
  streamPoster: mocks.poster,
  stablePlazaPlaybackUrl: () => 'fixture',
}));
vi.mock('./storage.js', () => ({
  validatePlazaImage: () => ({ width: 720, height: 1280 }),
  uploadPlazaVideoAsset: vi.fn(),
}));
vi.mock('../../platform/runtime-config.js', () => ({
  getVideoStreamConfig: () => ({ encodeDeadlineSeconds: 1800 }),
}));

import { VideoDeliveryRepository } from './video-delivery-repository.js';
import { uploadVideoDelivery } from './video-delivery-upload.js';
import { startVideoDeliveryJob, stopVideoDeliveryJob } from './video-delivery-job.js';
import { VideoStreamError } from './video-stream-client.js';

let job: DeliveryJob;
const bytes = Buffer.alloc(20 * 1024 * 1024);
const attempt = {
  id: 'fixture-attempt',
  user_id: 'fixture-user',
  conversation_id: 'fixture-conversation',
  provider_request_id: 'fixture-queue',
  provider_model_id: 'fixture-model',
  duration_s: 5,
} as VideoAttemptRow;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
beforeEach(() => {
  vi.resetAllMocks();
  job = {
    id: 'fixture-job',
    attempt_id: attempt.id,
    stage: 'uploading',
    stream_uid: 'a'.repeat(32),
    upload_url: 'https://upload.videodelivery.net/tus/fixture',
    source_sha256: 'fixture-hash',
    source_byte_size: bytes.length,
    lease_token: 'fixture-lease',
    retry_count: 0,
    deadline_at: new Date(Date.now() + 1_800_000).toISOString(),
    created_at: new Date().toISOString(),
  };
  mocks.retrieve.mockResolvedValue({ kind: 'completed', bytes });
  mocks.claim.mockResolvedValue([]);
  mocks.attempt.mockResolvedValue(attempt);
  mocks.failedAssets.mockResolvedValue([]);
  mocks.verify.mockResolvedValue({ width: 720, height: 1280, durationMs: 5000, renditionCount: 2 });
  mocks.poster.mockResolvedValue(Buffer.alloc(1));
  mocks.complete.mockResolvedValue(undefined);
});
afterEach(async () => {
  await stopVideoDeliveryJob();
  vi.restoreAllMocks();
});

describe('bounded video delivery rounds', () => {
  it('uploads a 20 MiB source in four chunks with one source read and a fence after each', async () => {
    mocks.chunk
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await uploadVideoDelivery(
      new VideoDeliveryRepository(),
      job,
      attempt,
      new AbortController().signal
    );
    expect(mocks.retrieve).toHaveBeenCalledOnce();
    expect(mocks.chunk).toHaveBeenCalledTimes(4);
    expect(mocks.checkpoint).toHaveBeenCalledTimes(5);
    expect(mocks.checkpoint.mock.calls[3]![1]).toMatchObject({
      stage: 'encoding',
      upload_url: null,
    });
    expect(mocks.checkpoint.mock.calls[4]![1]).toMatchObject({ lease_token: null });
    for (const call of mocks.chunk.mock.calls) expect(call[1]).toBe(bytes);
  });
  it('yields after four chunks and resumes the same TUS session in a later round', async () => {
    mocks.chunk.mockResolvedValue(false);
    const repo = new VideoDeliveryRepository();
    await uploadVideoDelivery(repo, job, attempt, new AbortController().signal);
    expect(mocks.chunk).toHaveBeenCalledTimes(4);
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.chunk.mockResolvedValue(true);
    await uploadVideoDelivery(repo, job, attempt, new AbortController().signal);
    expect(mocks.chunk).toHaveBeenCalledTimes(5);
    expect(mocks.retrieve).toHaveBeenCalledTimes(2);
  });
  it('yields the lease after the upload burst budget without starting another chunk', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(20_001);
    mocks.chunk.mockResolvedValue(false);
    await uploadVideoDelivery(
      new VideoDeliveryRepository(),
      job,
      attempt,
      new AbortController().signal
    );
    expect(mocks.chunk).toHaveBeenCalledOnce();
    expect(mocks.checkpoint.mock.calls.at(-1)![1]).toMatchObject({ lease_token: null });
  });
  it('starts no further chunk after caller cancellation', async () => {
    const budget = new AbortController();
    mocks.chunk.mockImplementationOnce(async () => {
      budget.abort();
      return false;
    });
    await expect(
      uploadVideoDelivery(new VideoDeliveryRepository(), job, attempt, budget.signal)
    ).rejects.toThrow();
    expect(mocks.chunk).toHaveBeenCalledOnce();
    expect(mocks.checkpoint).toHaveBeenCalledExactlyOnceWith(job, {
      stage: 'uploading',
      retry_count: 0,
    });
  });
  it('starts no further upload after losing the checkpoint fence', async () => {
    mocks.chunk.mockResolvedValue(false);
    mocks.checkpoint.mockRejectedValue(new Error('video_delivery_lease_lost'));
    await expect(
      uploadVideoDelivery(new VideoDeliveryRepository(), job, attempt, new AbortController().signal)
    ).rejects.toThrow('lease_lost');
    expect(mocks.chunk).toHaveBeenCalledOnce();
  });
});

describe('worker shutdown preserves write uncertainty', () => {
  it('preserves a provider Retry-After racing a shutdown', async () => {
    mocks.claim.mockResolvedValueOnce([job]);
    mocks.chunk.mockImplementation(
      (_session, _bytes, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new VideoStreamError('video_stream_upload_429', true, false, 60_000)),
            { once: true }
          );
        })
    );
    startVideoDeliveryJob(log);
    await vi.waitFor(() => expect(mocks.chunk).toHaveBeenCalledOnce());
    await stopVideoDeliveryJob();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(job, true, 60_000);
    expect(mocks.fail).not.toHaveBeenCalled();
  });
  it('keeps the lease protected if an operation ignores abort beyond the drain deadline', async () => {
    let settle!: (done: boolean) => void;
    mocks.claim.mockResolvedValueOnce([job]);
    mocks.chunk.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        })
    );
    startVideoDeliveryJob(log);
    await vi.waitFor(() => expect(mocks.chunk).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const stopping = stopVideoDeliveryJob();
    await vi.advanceTimersByTimeAsync(30_000);
    await stopping;
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    settle(false);
    vi.useRealTimers();
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledExactlyOnceWith(job));
  });
  it('aborts and drains a known upload before releasing the existing lease', async () => {
    mocks.claim.mockResolvedValueOnce([job]);
    mocks.chunk.mockImplementation(
      (_session, _bytes, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    startVideoDeliveryJob(log);
    await vi.waitFor(() => expect(mocks.chunk).toHaveBeenCalledOnce());
    await stopVideoDeliveryJob();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(job);
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('retains creating protection when the non-idempotent POST response is lost', async () => {
    job.stage = 'queued';
    job.stream_uid = null;
    job.upload_url = null;
    mocks.claim.mockResolvedValueOnce([job]);
    mocks.create.mockImplementation(
      (_bytes, _id, _duration, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new VideoStreamError('video_stream_create_unknown', false, true)),
            { once: true }
          );
        })
    );
    startVideoDeliveryJob(log);
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    await stopVideoDeliveryJob();
    expect(job.stage).toBe('creating');
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
  });
  it('does not refund or release an unknown publish response', async () => {
    job.stage = 'encoding';
    mocks.claim.mockResolvedValueOnce([job]);
    mocks.publish.mockRejectedValue(new Error('fixture lost publish response'));
    startVideoDeliveryJob(log);
    await vi.waitFor(() =>
      expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unknown' }))
    );
    await stopVideoDeliveryJob();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
