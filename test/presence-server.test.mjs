import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createSlideSync } from '../src/server.mjs';
import { makePdf } from '../scripts/create-demo.mjs';

test('presence stays presenter-only over HTTP and WebSocket and merges reconnecting tabs', async (context) => {
  let now = Date.now();
  const application = await createSlideSync({ port: 0, host: '127.0.0.1', presenceNow: () => now });
  context.after(() => application.close());
  const base = `http://127.0.0.1:${application.port}`;
  const viewerUrl = `${base}/api/state?token=${application.viewerToken}`;
  const initial = await fetch(viewerUrl);
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  assert.equal(Object.hasOwn(await initial.json(), 'presence'), false);
  const hostState = () => fetch(`${base}/api/state`, { headers: { 'X-Host-Token': application.hostToken } }).then((response) => response.json());
  const connect = async (role) => {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?role=${role}&token=${role === 'host' ? application.hostToken : application.viewerToken}`,
      { headers: { Cookie: cookie }, origin: base });
    context.after(() => socket.terminate());
    const [raw] = await once(socket, 'message');
    const state = JSON.parse(raw.toString());
    assert.equal(Object.hasOwn(state, 'presence'), role === 'host');
    if (role !== 'host') socket.on('message', (message) => assert.equal(Object.hasOwn(JSON.parse(message.toString()), 'presence'), false));
    return socket;
  };
  await connect('host');
  const first = await connect('viewer');
  const second = await connect('viewer');
  let state = await hostState();
  assert.equal(state.presence.participants.length, 1);
  assert.equal(state.presence.participants[0].openSockets, 2);
  const id = state.presence.participants[0].id;
  const remove = (token, identity = id) => fetch(`${base}/api/host/presence/remove${token ? `?token=${token}` : ''}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? {} : { 'X-Host-Token': application.hostToken }) }, body: JSON.stringify({ id: identity }) });
  assert.equal((await remove(application.viewerToken)).status, 403);
  assert.equal((await remove()).status, 409);
  first.close(); second.close();
  await Promise.all([once(first, 'close'), once(second, 'close')]);
  now += 35001;
  state = await hostState();
  assert.equal(state.presence.totals.disconnected, 1);
  const back = await connect('viewer');
  state = await hostState();
  assert.equal(state.presence.totals.connected, 1);
  assert.equal(state.presence.participants[0].id, id);
  back.close();
  await once(back, 'close');
  now += 35001;
  assert.equal((await remove()).status, 200);
  assert.equal((await hostState()).presence.participants.length, 0);
});

test('HTTP fallback reports preload progress without leaking participant details', async (context) => {
  const application = await createSlideSync({ port: 0, host: '127.0.0.1' });
  context.after(() => application.close());
  const base = `http://127.0.0.1:${application.port}`;
  const body = new FormData();
  body.append('pdf', new Blob([makePdf(2)]), 'health.pdf');
  const hostHeaders = { 'X-Host-Token': application.hostToken };
  const uploaded = await fetch(`${base}/api/host/pdf`, { method: 'POST', headers: hostHeaders, body }).then((response) => response.json());
  const initial = await fetch(`${base}/api/state?token=${application.viewerToken}`);
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  await fetch(`${base}/api/state?token=${application.viewerToken}`);
  const unconfirmed = await fetch(`${base}/api/state`, { headers: hostHeaders }).then((response) => response.json());
  assert.equal(unconfirmed.presence.participants.length, 0);
  const report = (message, token = application.viewerToken) => fetch(`${base}/api/ready?token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(message),
  });
  assert.equal((await report({ deckId: uploaded.deck.id, loaded: 2 }, 'wrong')).status, 401);
  assert.equal((await report({ deckId: 'old', loaded: 2 })).status, 409);
  assert.equal((await report({ deckId: uploaded.deck.id, loaded: 3 })).status, 400);
  const ready = await report({ deckId: uploaded.deck.id, loaded: 2 });
  assert.deepEqual(await ready.json(), { ok: true });
  const state = await fetch(`${base}/api/state`, { headers: hostHeaders }).then((response) => response.json());
  assert.equal(state.presence.totals.fallback, 1);
  assert.equal(state.presence.participants[0].loaded, 2);
  assert.equal(state.ready, 0);
  assert.equal(Object.hasOwn(await fetch(`${base}/api/state?token=${application.viewerToken}`, { headers: { Cookie: cookie } }).then((response) => response.json()), 'presence'), false);
});
