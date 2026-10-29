import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { access } from 'node:fs/promises';
import { loadImage } from '@napi-rs/canvas';
import { WebSocket } from 'ws';
import { createSlideSync, LIMITS, localAddresses } from '../src/server.mjs';
import { makePdf } from '../scripts/create-demo.mjs';

let application;
let base;
let deck;
const clients = [];
before(async () => {
  application = await createSlideSync({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${application.port}`;
});
after(async () => {
  for (const client of clients) client.terminate();
  if (!application) return;
  await application.close();
  await assert.rejects(access(application.storage));
});

function hostFetch(route, options = {}) {
  return fetch(`${base}${route}`, { ...options, headers: { 'X-Host-Token': application.hostToken, ...options.headers } });
}
async function upload(bytes = makePdf(), name = 'demo.pdf') {
  const body = new FormData();
  body.append('pdf', new Blob([bytes], { type: 'application/pdf' }), name);
  return hostFetch('/api/host/pdf', { method: 'POST', body });
}
function waitState(client, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('message', listener); reject(new Error('State timed out')); }, 8000);
    const listener = (raw) => {
      const state = JSON.parse(raw.toString());
      if (state.type === 'state' && predicate(state)) {
        clearTimeout(timer);
        client.off('message', listener);
        resolve(state);
      }
    };
    client.on('message', listener);
  });
}
function connect() {
  const client = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${application.viewerToken}`, { origin: base });
  clients.push(client);
  return client;
}

test('requires session credentials; blocks other origins and DNS rebinding hosts', async () => {
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/api/host/config`)).status, 403);
  assert.equal((await fetch(`${base}/api/state?token=${'ї'.repeat(48)}`)).status, 401);
  assert.equal((await hostFetch('/api/host/config', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/host/config`, { headers: { Host: 'evil.example', 'X-Host-Token': application.hostToken } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  const config = await hostFetch('/api/host/config').then((response) => response.json());
  assert.ok(Array.isArray(config.links));
  for (const link of config.links) {
    assert.match(link.qr, /^data:image\/png;base64,/);
    assert.ok(link.url.endsWith(`#token=${application.viewerToken}`));
    assert.ok(!link.url.includes('127.0.0.1'));
  }
});

test('renders real PDF to JPEGs, preserves dimensions, provides authenticated immutable assets', async () => {
  const response = await upload();
  assert.equal(response.status, 200, await response.clone().text());
  const state = await response.json();
  deck = state.deck;
  assert.equal(deck.pages.length, 5);
  assert.equal(state.slide, 0);
  assert.equal(deck.pages[0].width, 1600);
  assert.equal(deck.pages[0].height, 900);
  assert.ok(deck.totalBytes > 10_000);
  assert.equal((await fetch(`${base}/slides/${deck.id}/1.jpg`)).status, 401);
  const imageResponse = await fetch(`${base}/slides/${deck.id}/1.jpg?token=${application.viewerToken}`);
  assert.match(imageResponse.headers.get('content-type'), /image\/jpeg/);
  assert.match(imageResponse.headers.get('cache-control'), /immutable/);
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8');
  const image = await loadImage(bytes);
  assert.equal(image.width, 1600);
  assert.equal(image.height, 900);
  for (const page of ['0.jpg', '6.jpg', '1.jpg.bak', '-1.jpg']) {
    assert.equal((await fetch(`${base}/slides/${deck.id}/${page}?token=${application.viewerToken}`)).status, 404);
  }
});

test('synchronizes 25 viewers, tracks preload readiness, rejects viewer control, reconnects at current slide', async () => {
  const viewers = Array.from({ length: 25 }, connect);
  const initial = await Promise.all(viewers.map((client) => waitState(client, (state) => state.deck?.id === deck.id)));
  assert.ok(initial.every((state) => state.slide === 0));
  const waiting = viewers.map((client) => waitState(client, (state) => state.slide === 3));
  const response = await hostFetch('/api/host/slide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deckId: deck.id, index: 3 }) });
  assert.equal(response.status, 200);
  const states = await Promise.all(waiting);
  assert.ok(states.every((state) => state.slide === 3));
  const readyState = waitState(viewers[0], (state) => state.ready === 1);
  viewers[0].send(JSON.stringify({ type: 'ready', deckId: deck.id, loaded: deck.pages.length }));
  assert.equal((await readyState).ready, 1);
  viewers[0].send(JSON.stringify({ type: 'slide', index: 0 }));
  const snapshot = await hostFetch('/api/state').then((result) => result.json());
  assert.equal(snapshot.slide, 3);
  const newViewer = connect();
  assert.equal((await waitState(newViewer, (state) => state.slide === 3)).slide, 3);
  assert.equal((await fetch(`${base}/api/host/slide?token=${application.viewerToken}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deckId: deck.id, index: 0 }) })).status, 403);
});

test('rejects out-of-range indices, floats and stale deck commands', async () => {
  for (const index of [-1, 5, 1.5, '2', null]) {
    const result = await hostFetch('/api/host/slide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deckId: deck.id, index }) });
    assert.equal(result.status, 400);
  }
  const stale = await hostFetch('/api/host/slide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deckId: 'old-deck', index: 0 }) });
  assert.equal(stale.status, 409);
});

test('bad PDFs and page limits keep existing deck and clear upload lock', async () => {
  assert.equal((await upload(Buffer.from('not a pdf'))).status, 400);
  assert.equal((await upload(Buffer.from('%PDF-1.7\nbroken'))).status, 422);
  assert.equal((await upload(makePdf(151))).status, 422);
  const state = await hostFetch('/api/state').then((response) => response.json());
  assert.equal(state.deck.id, deck.id);
  assert.equal(state.processing, null);
  assert.equal(state.slide, 3);
});

test('password-protected PDFs produce an actionable error without replacing deck', async () => {
  const encryption = `/Encrypt << /Filter /Standard /V 1 /R 2 /Length 40 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >> /ID [<${'00'.repeat(16)}> <${'00'.repeat(16)}>]`;
  const bytes = Buffer.from(makePdf(1).toString().replace('/Root 1 0 R >>', `/Root 1 0 R ${encryption} >>`));
  const response = await upload(bytes);
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /паролем/);
  const state = await hostFetch('/api/state').then((result) => result.json());
  assert.equal(state.deck.id, deck.id);
});

test('serializes uploads and atomically replaces deck, removing stale asset URLs', async () => {
  const first = upload(makePdf(3), 'new.pdf');
  const competing = await upload(makePdf(2));
  assert.equal(competing.status, 409);
  const response = await first;
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.notEqual(state.deck.id, deck.id);
  assert.equal(state.deck.pages.length, 3);
  assert.equal(state.slide, 0);
  assert.equal(state.ready, 0);
  assert.equal((await fetch(`${base}/slides/${deck.id}/1.jpg?token=${application.viewerToken}`)).status, 404);
  deck = state.deck;
});

test('rejects oversized uploads and extra multipart fields', async () => {
  const response = await upload(Buffer.alloc(LIMITS.pdfBytes + 1));
  assert.equal(response.status, 413);
  const body = new FormData();
  body.append('extra', 'field');
  body.append('pdf', new Blob([makePdf()]), 'demo.pdf');
  assert.equal((await hostFetch('/api/host/pdf', { method: 'POST', body })).status, 400);
});

test('WebSocket rejects foreign origins, invalid roles and invalid tokens without server failure', async () => {
  for (const options of [
    { query: `token=${application.viewerToken}`, origin: 'https://evil.example' },
    { query: `token=${application.viewerToken}&role=host`, origin: base },
    { query: `token=${encodeURIComponent('ї'.repeat(48))}`, origin: base },
  ]) {
    const client = new WebSocket(`${base.replace('http:', 'ws:')}/ws?${options.query}`, { origin: options.origin });
    const [error] = await once(client, 'error');
    assert.match(error.message, /403/);
  }
  assert.equal((await hostFetch('/api/state')).status, 200);
});

test('renderer timeout leaves server responsive and cleans partial files', async () => {
  const short = await createSlideSync({ port: 0, host: '127.0.0.1', renderMs: 1 });
  try {
    const body = new FormData();
    body.append('pdf', new Blob([makePdf()]), 'demo.pdf');
    const response = await fetch(`http://127.0.0.1:${short.port}/api/host/pdf`, { method: 'POST', headers: { 'X-Host-Token': short.hostToken }, body });
    assert.equal(response.status, 422);
    const state = await fetch(`http://127.0.0.1:${short.port}/api/state?token=${short.viewerToken}`).then((result) => result.json());
    assert.equal(state.deck, null);
    assert.equal(state.processing, null);
  } finally { await short.close(); }
});

test('handles rotated pages and Ukrainian filenames', async () => {
  const response = await upload(makePdf(1, { rotation: 90 }), 'Презентація.pdf');
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.deck.name, 'Презентація.pdf');
  assert.equal(state.deck.pages[0].width, 900);
  assert.equal(state.deck.pages[0].height, 1600);
});

test('LAN requests can view but cannot control even with the host token', async (context) => {
  const [address] = localAddresses();
  if (!address) { context.skip('No active LAN IPv4 interface'); return; }
  const lan = await createSlideSync({ port: 0 });
  try {
    const lanBase = `http://${address}:${lan.port}`;
    assert.equal((await fetch(`${lanBase}/api/state?token=${lan.viewerToken}`)).status, 200);
    assert.equal((await fetch(`${lanBase}/host`)).status, 403);
    assert.equal((await fetch(`${lanBase}/api/host/config`, { headers: { 'X-Host-Token': lan.hostToken } })).status, 403);
    const client = new WebSocket(`${lanBase.replace('http:', 'ws:')}/ws?role=host&token=${lan.hostToken}`);
    const [error] = await once(client, 'error');
    assert.match(error.message, /403/);
  } finally { await lan.close(); }
});
