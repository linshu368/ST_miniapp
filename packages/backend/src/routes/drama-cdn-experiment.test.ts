import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { DRAMA_CDN_SAMPLE_ID } from '@miniapp/shared';
import { DramaCdnExperiment, sourceExpiry } from '../features/drama/cdn-experiment.js';
const state = vi.hoisted(() => ({
  userId: 7116726082,
  denied: false,
  enabled: true,
  deadlineMs: 0,
  sourceUrl: '',
}));
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (
    req: { user?: { id: number } },
    reply: { status: (n: number) => { send: (body: unknown) => unknown } }
  ) => {
    if (state.denied) return reply.status(401).send({ error: 'unauthorized' });
    req.user = { id: state.userId };
  },
}));
vi.mock('../platform/runtime-config.js', () => ({
  getDramaCdnExperimentConfig: () => ({
    enabled: state.enabled,
    userIds: [7116726082],
    sourceUrl: state.sourceUrl,
    tokenKey: 'unit-only-signing-material',
    deadlineMs: state.deadlineMs,
  }),
}));
import routes from './drama-cdn-experiment.js';
const NOW = Date.parse('2026-10-28T13:00:00Z');
function source(exp = NOW / 1000 + 7200) {
  const payload = Buffer.from(
    JSON.stringify({ exp, url: `drama-videos/videos/${DRAMA_CDN_SAMPLE_ID}/original` })
  ).toString('base64url');
  return `https://wbtsfzozlmurljvglhpn.supabase.co/storage/v1/object/sign/drama-videos/videos/${DRAMA_CDN_SAMPLE_ID}/original?token=unit.${payload}.unit`;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  Object.assign(state, {
    userId: 7116726082,
    denied: false,
    enabled: true,
    deadlineMs: NOW + 3600000,
    sourceUrl: source(),
  });
});
afterEach(() => vi.useRealTimers());
async function request(query = `video_id=${DRAMA_CDN_SAMPLE_ID}&route=bunny`) {
  const app = Fastify();
  await app.register(routes);
  try {
    return await app.inject(`/api/drama-cdn-experiment/play?${query}`);
  } finally {
    await app.close();
  }
}
describe('bounded CDN access', () => {
  it('rejects missing authentication, other accounts and a closed experiment', async () => {
    state.denied = true;
    expect((await request()).statusCode).toBe(401);
    state.denied = false;
    state.userId = 99999;
    expect((await request()).statusCode).toBe(403);
    state.enabled = false;
    expect((await request()).statusCode).toBe(404);
  });
  it('rejects non-sample IDs, unknown paths, extra selectors and invalid routes', async () => {
    for (const query of [
      'video_id=other&route=bunny',
      `video_id=${DRAMA_CDN_SAMPLE_ID}&route=other`,
      `video_id=${DRAMA_CDN_SAMPLE_ID}&route=bunny&url=https://example.invalid`,
      'route=bunny',
    ])
      expect((await request(query)).statusCode).toBe(400);
  });
  it('keeps the exact source URL and signs only the CDN path with a separate HMAC', async () => {
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const playback = response.json().data.playback;
    const url = new URL(playback.play_url);
    expect(url.hostname).toBe('stminiappvid20261028.b-cdn.net');
    expect(url.pathname).toBe('/experiment/v1.mp4');
    expect(url.searchParams.get('token')).toBe(
      'HS256-' +
        createHmac('sha256', 'unit-only-signing-material')
          .update('/experiment/v1.mp4' + url.searchParams.get('expires'))
          .digest('base64url')
    );
    expect(Number(url.searchParams.get('expires'))).toBeLessThanOrEqual((NOW + 1800000) / 1000);
    expect(
      (await request(`video_id=${DRAMA_CDN_SAMPLE_ID}&route=original`)).json().data.playback
        .play_url
    ).toBe(state.sourceUrl);
  });
  it('stops Bunny at deadline while permitting a newly requested valid original', async () => {
    state.deadlineMs = NOW - 1;
    expect((await request()).statusCode).toBe(410);
    expect((await request(`video_id=${DRAMA_CDN_SAMPLE_ID}&route=original`)).statusCode).toBe(200);
    state.sourceUrl = source(NOW / 1000 + 60);
    expect((await request(`video_id=${DRAMA_CDN_SAMPLE_ID}&route=original`)).statusCode).toBe(410);
  });
  it('refuses a different origin/object and caches the complete CDN URL only while safe', () => {
    expect(sourceExpiry(source().replace('wbtsfzozlmurljvglhpn', 'another'))).toBe(0);
    expect(sourceExpiry(source().replace('/original?', '/other?'))).toBe(0);
    const service = new DramaCdnExperiment();
    const cfg = {
      enabled: true,
      userIds: [1],
      sourceUrl: source(),
      tokenKey: 'unit-only',
      deadlineMs: NOW + 3600000,
    };
    const first = service.playback(cfg, 'bunny', NOW);
    expect(service.playback(cfg, 'bunny', NOW + 30000)).toEqual(first);
    expect(service.playback(cfg, 'bunny', NOW + 1800000)?.play_url).not.toBe(first?.play_url);
    expect(service.playback({ ...cfg, sourceUrl: source(NOW / 1000) }, 'original', NOW)).toBeNull();
  });
});
