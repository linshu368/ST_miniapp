import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createPreviewServer } from './server.js';
import { IDS, makeData } from './data.js';
import {
  PublicReplyStyleOptionSchema,
  VipStatusSchema,
  UserSettingsSchema,
  ImagePlazaWorkSchema,
} from '@miniapp/shared';

let api: string;
let server: ReturnType<typeof createPreviewServer>['server'];
before(async () => {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((done) => probe.close(() => done()));
  ({ server } = createPreviewServer(port, port + 1));
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  api = `http://127.0.0.1:${port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});
const post = (path: string, body: unknown) =>
  fetch(api + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

test('fixture uses public shared contracts', () => {
  const data = makeData('http://127.0.0.1:3121');
  VipStatusSchema.parse(data.vip);
  UserSettingsSchema.parse(data.settings);
  for (const work of data.works) ImagePlazaWorkSchema.parse(work);
  for (const style of data.generation.reply_style_options)
    PublicReplyStyleOptionSchema.parse(style);
});

test('unknown endpoints fail visibly and are recorded; external origins cannot reset', async () => {
  assert.equal((await fetch(api + '/api/not-implemented')).status, 501);
  const external = await fetch(api + '/__preview/reset', {
    method: 'POST',
    headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'vip' }),
  });
  assert.equal(external.status, 403);
  assert.equal((await post('/__preview/reset', { scenario: 'undefined' })).status, 400);
});

test('scenario reset and check-in are repeatable; a second claim cannot add balance', async () => {
  await post('/__preview/reset', { scenario: 'vip' });
  const first = await post('/api/wallet/checkin', {});
  assert.equal((await first.json()).data.wallet.credits, 3750);
  assert.equal((await post('/api/wallet/checkin', {})).status, 409);
  await post('/__preview/reset', { scenario: 'standard' });
  const state = await (await fetch(api + '/__preview/state')).json();
  assert.equal(state.wallet.credits, 3600);
  assert.deepEqual(state.unhandled, []);
});

test('SSE reasoning respects the switch and preserves shared event framing', async () => {
  for (const enabled of [true, false]) {
    await post('/__preview/reset', { scenario: 'standard' });
    const res = await post(`/api/v1/conversations/${IDS.session}/messages`, {
      content: '继续走吧',
      thinking_enabled: enabled,
    });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const frames = (await res.text())
      .trim()
      .split('\n\n')
      .map((frame) => JSON.parse(frame.slice(6)));
    assert.equal(frames[0].type, 'start');
    assert.equal(
      frames.some((frame) => frame.type === 'reasoning'),
      enabled
    );
    assert.equal(frames.at(-1).type, 'done');
    assert.ok(frames.some((frame) => frame.type === 'delta'));
  }
});
