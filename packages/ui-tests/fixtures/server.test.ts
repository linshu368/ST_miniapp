import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createPreviewServer } from './server.js';
import { IDS, WISH_IDS, makeData } from './data.js';
import {
  CharacterWishListDataSchema,
  CharacterWishDetailDataSchema,
  getNextDailyCheckinAt,
  type GetConversationData,
  PublicReplyStyleOptionSchema,
  VipStatusSchema,
  UserSettingsSchema,
  ImagePlazaWorkSchema,
} from '@miniapp/shared';

test('check-in fixture returns a stable next Beijing midnight and rejects duplicate claims', async () => {
  await post('/__preview/reset', { scenario: 'standard' });
  const claim = (await (await post('/api/wallet/checkin', {})).json()).data.checkin;
  assert.equal(claim.next_claim_at, getNextDailyCheckinAt(claim.claimed_at));
  const state = (await (await fetch(api + '/api/wallet/checkin')).json()).data.checkin;
  assert.equal(state.last_claimed_at, claim.claimed_at);
  assert.equal(state.next_claim_at, claim.next_claim_at);
  assert.equal(state.can_claim, false);
  assert.equal((await post('/api/wallet/checkin', {})).status, 409);
});

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

test('reply likes aggregate into character totals and remain idempotent and independent in branches', async () => {
  await post('/__preview/reset', { scenario: 'standard' });
  const beforeSocial = await (await fetch(api + `/api/characters/${IDS.character}/social`)).json();
  const messageId = '50000000-0000-4000-8000-000000000003';
  const path = `/api/v1/conversations/${IDS.session}/messages/${messageId}/like`;
  const setLike = (liked: boolean) =>
    fetch(api + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liked }),
    });
  assert.equal((await setLike(true)).status, 200);
  assert.equal((await setLike(true)).status, 200);
  const likedSocial = await (await fetch(api + `/api/characters/${IDS.character}/social`)).json();
  assert.equal(likedSocial.data.social.like_count, beforeSocial.data.social.like_count + 1);
  assert.equal(likedSocial.data.social.liked, false);
  const detail = (await (await fetch(api + `/api/v1/conversations/${IDS.session}`)).json())
    .data as GetConversationData;
  assert.equal(detail.messages.find((m) => m.id === messageId)?.liked, true);
  const branch = (
    await (
      await post(`/api/v1/conversations/${IDS.session}/branch`, {
        message_id: messageId,
        request_id: '53000000-0000-4000-8000-000000000003',
      })
    ).json()
  ).data as GetConversationData;
  assert.equal(branch.messages.find((m) => m.id === messageId)?.liked, false);
  assert.equal((await setLike(false)).status, 200);
  const final = (await (await fetch(api + `/api/v1/conversations/${IDS.session}`)).json())
    .data as GetConversationData;
  assert.equal(final.messages.find((m) => m.id === messageId)?.liked, false);
  const invalid = await fetch(api + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ liked: true, user_id: 'forbidden' }),
  });
  assert.equal(invalid.status, 400);
  const state = await (await fetch(api + '/__preview/state')).json();
  assert.equal(state.wallet.credits, 3600);
  assert.deepEqual(
    await (await fetch(api + `/api/characters/${IDS.character}/social`)).json(),
    beforeSocial
  );
  await post('/__preview/reset', { scenario: 'chat-branch' });
  for (const turn of [199, 200]) {
    const result = await fetch(
      api +
        `/api/v1/conversations/${IDS.session}/messages/52000000-0000-4000-8000-${String(turn).padStart(12, '0')}/like`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liked: true }),
      }
    );
    assert.equal(result.status, 200);
  }
  const multiple = await (await fetch(api + `/api/characters/${IDS.character}/social`)).json();
  assert.equal(multiple.data.social.like_count, beforeSocial.data.social.like_count + 2);
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

test('branch fixture retains at most 50 earlier turns and replays an uncertain creation', async () => {
  await post('/__preview/reset', { scenario: 'chat-branch' });
  const branch = await post(`/api/v1/conversations/${IDS.session}/branch`, {
    message_id: '52000000-0000-4000-8000-000000000060',
    request_id: '53000000-0000-4000-8000-000000000001',
  });
  assert.equal(branch.status, 200);
  const result = (await branch.json()).data;
  assert.equal(result.session.branch.inherited_turns, 50);
  assert.equal(result.session.branch.source_turn_index, 60);
  assert.equal(result.has_more, true);
  const firstPage = (
    await (
      await fetch(api + `/api/v1/conversations/${result.session.id}?before_turn_index=26`)
    ).json()
  ).data;
  assert.equal(firstPage.has_more, false);
  assert.match(
    firstPage.messages.find(
      (message: { role: string; turn_index: number }) =>
        message.role === 'assistant' && message.turn_index === 1
    ).content,
    /第 11 轮/
  );
  assert.ok(result.messages.every((message: { inherited: boolean }) => message.inherited));
  assert.equal((await (await fetch(api + '/api/v1/conversations')).json()).data.sessions.length, 2);

  await post('/__preview/reset', { scenario: 'chat-branch-error' });
  const input = {
    message_id: '52000000-0000-4000-8000-000000000020',
    request_id: '53000000-0000-4000-8000-000000000002',
  };
  assert.equal((await post(`/api/v1/conversations/${IDS.session}/branch`, input)).status, 503);
  const recovered = (
    await (await post(`/api/v1/conversations/${IDS.session}/branch`, input)).json()
  ).data;
  assert.equal(recovered.session.branch.inherited_turns, 20);
  assert.equal(recovered.has_more, false);
  const sessions = (await (await fetch(api + '/api/v1/conversations')).json()).data.sessions;
  assert.equal(sessions.length, 2);
  assert.equal(
    sessions.find((session: { id: string }) => session.id === IDS.session).message_count,
    40
  );
  assert.equal(
    (
      await post(`/api/v1/conversations/${IDS.session}/branch`, {
        ...input,
        message_id: '52000000-0000-4000-8000-000000000019',
      })
    ).status,
    409
  );
});

test('wish fixtures expose anonymous public wishes, scope mine by author and keep support/response retries idempotent', async () => {
  await post('/__preview/reset', { scenario: 'wishes' });
  const wall = CharacterWishListDataSchema.parse(
    (await (await fetch(api + '/api/character-wishes')).json()).data
  );
  assert.equal(wall.items.length, 4);
  assert.ok(wall.items.every((wish) => wish.visibility === 'public'));
  assert.ok(wall.items.every((wish) => !('user_id' in wish)));
  const mine = CharacterWishListDataSchema.parse(
    (await (await fetch(api + '/api/character-wishes?scope=mine')).json()).data
  );
  assert.equal(mine.items.length, 2);
  assert.ok(mine.items.every((wish) => wish.is_mine));
  assert.ok(mine.items.some((wish) => wish.id === WISH_IDS.mineGarden));
  const support = () =>
    fetch(api + `/api/character-wishes/${WISH_IDS.adventure}/support`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supported: true }),
    });
  assert.equal((await support()).status, 200);
  assert.equal((await support()).status, 200);
  const detail = CharacterWishDetailDataSchema.parse(
    (await (await fetch(api + `/api/character-wishes/${WISH_IDS.adventure}`)).json()).data
  );
  assert.equal(detail.wish.wanted_count, 19);
  assert.equal(detail.wish.supported, true);
  const respond = () =>
    post(`/api/character-wishes/${WISH_IDS.adventure}/responses`, {
      character_id: WISH_IDS.ownCard,
    });
  assert.equal((await respond()).status, 200);
  assert.equal((await respond()).status, 200);
  const responded = CharacterWishDetailDataSchema.parse(
    (await (await fetch(api + `/api/character-wishes/${WISH_IDS.adventure}`)).json()).data
  );
  assert.equal(responded.cards.length, 1);
  assert.equal(responded.wish.response_count, 1);
  await fetch(api + `/api/creator/characters/${WISH_IDS.ownCard}/visibility`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_revision: 1, visibility: 'private' }),
  });
  const hidden = CharacterWishDetailDataSchema.parse(
    (await (await fetch(api + `/api/character-wishes/${WISH_IDS.adventure}`)).json()).data
  );
  assert.equal(hidden.cards.length, 0);
  const notifications = (await (await fetch(api + '/api/notifications?scope=personal')).json()).data
    .notifications;
  assert.equal(notifications.length, 1, 'own responses do not notify the creator');
  assert.equal(notifications[0].action_path, `/wishes/${WISH_IDS.minePublic}`);
});

test('wish creation fixture rejects private requests, recovers without duplicates and validates the 500 character limit', async () => {
  await post('/__preview/reset', { scenario: 'wishes-error' });
  const input = {
    id: 'a1000000-0000-4000-8000-000000000006',
    body: '想和探险家一起找出海图的秘密。',
    visibility: 'public',
  };
  assert.equal(
    (await post('/api/character-wishes', { ...input, visibility: 'private' })).status,
    400
  );
  assert.equal((await post('/api/character-wishes', input)).status, 503);
  assert.equal((await post('/api/character-wishes', input)).status, 200);
  assert.equal((await post('/api/character-wishes', input)).status, 200);
  const mine = CharacterWishListDataSchema.parse(
    (await (await fetch(api + '/api/character-wishes?scope=mine')).json()).data
  );
  assert.equal(mine.items.filter((wish) => wish.id === input.id).length, 1);
  assert.equal(
    (await post('/api/character-wishes', { ...input, body: '想'.repeat(501) })).status,
    400
  );
  await fetch(api + `/api/character-wishes/${input.id}`, { method: 'DELETE' });
  assert.equal((await fetch(api + `/api/character-wishes/${input.id}`)).status, 404);
});
