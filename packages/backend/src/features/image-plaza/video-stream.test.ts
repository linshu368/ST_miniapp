import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createStreamUpload,
  uploadStreamChunk,
  assertStreamUploadUrl,
} from './video-stream-upload.js';
import { verifyStreamReady } from './video-stream-playback.js';
import { VideoStreamError, readStreamBody } from './video-stream-client.js';

vi.mock('../../platform/runtime-config.js', () => ({
  getVideoStreamConfig: () => ({
    accountId: 'a'.repeat(32),
    apiToken: 'fixture-token',
    environment: 'test',
  }),
  getDramaStreamSigningConfig: () => ({
    host: 'customer-fixture.cloudflarestream.com',
    keyId: 'fixture',
    privateKey: '',
  }),
}));
vi.mock('../../lib/stream-signing.js', () => ({
  signStreamToken: () => ({ token: 'fixture-playback', expires_at: '2026-11-17T00:00:00Z' }),
}));
const uid = 'b'.repeat(32);
const url = 'https://upload.videodelivery.net/tus/fixture';
afterEach(() => vi.unstubAllGlobals());
function mp4() {
  const bytes = Buffer.alloc(128);
  bytes.write('ftyp', 4);
  return bytes;
}
function session(bytes: Buffer) {
  return {
    uid,
    uploadUrl: url,
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('Stream delivery protocol boundaries', () => {
  it('requires private playback and saves the response UID without parsing a capability URL', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 201, headers: { location: url, 'stream-media-id': uid } })
      );
    vi.stubGlobal('fetch', fetch);
    expect(await createStreamUpload(mp4(), 'attempt')).toMatchObject({ uid, uploadUrl: url });
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('upload-metadata')).toContain('requiresignedurls');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('never retries an ambiguous creation or trusts a foreign upload origin', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('lost response'));
    vi.stubGlobal('fetch', fetch);
    await expect(createStreamUpload(mp4(), 'attempt')).rejects.toMatchObject({
      outcomeUnknown: true,
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(assertStreamUploadUrl('https://upload.cloudflarestream.com/tus/fixture')).toBe(
      'https://upload.cloudflarestream.com/tus/fixture'
    );
    for (const value of [
      'http://upload.videodelivery.net/x',
      'https://evil.test/x',
      'https://user:pass@upload.videodelivery.net/x',
    ])
      expect(() => assertStreamUploadUrl(value)).toThrow();
  });
  it('resolves a lost PATCH with HEAD, without sending another body or the management token', async () => {
    const bytes = mp4();
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'upload-offset': String(bytes.length), 'upload-length': String(bytes.length) },
      })
    );
    vi.stubGlobal('fetch', fetch);
    expect(await uploadStreamChunk(session(bytes), bytes)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('HEAD');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });
  it('rejects changed source bytes and out-of-range offsets before PATCH', async () => {
    const bytes = mp4();
    const saved = session(bytes);
    bytes[12] = 1;
    await expect(uploadStreamChunk(saved, bytes)).rejects.toMatchObject({
      code: 'video_stream_source_changed',
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'upload-offset': '999', 'upload-length': '128' },
      })
    );
    vi.stubGlobal('fetch', fetch);
    await expect(uploadStreamChunk(session(bytes), bytes)).rejects.toMatchObject({
      code: 'video_stream_offset_invalid',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds response allocations and rejects publicly accessible Stream configuration', async () => {
    await expect(readStreamBody(new Response('12345'), 4)).rejects.toBeInstanceOf(VideoStreamError);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          success: true,
          result: {
            uid,
            requireSignedURLs: false,
            readyToStream: true,
            status: { state: 'ready' },
            input: { width: 1280, height: 720 },
            duration: 5,
          },
        })
      )
    );
    await expect(verifyStreamReady(uid)).rejects.toMatchObject({
      code: 'video_stream_privacy_invalid',
    });
  });
  it('waits for all encoding and at least two genuine bandwidth variants', async () => {
    const result = {
      uid,
      requireSignedURLs: true,
      readyToStream: true,
      status: { state: 'inprogress' },
      input: { width: 1280, height: 720 },
      duration: 5,
    };
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: true, result }));
    vi.stubGlobal('fetch', fetch);
    expect(await verifyStreamReady(uid)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { ...result, status: { state: 'ready' } } })
      )
      .mockResolvedValueOnce(
        new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nlow.m3u8\n')
      );
    expect(await verifyStreamReady(uid)).toBeNull();
  });
});
