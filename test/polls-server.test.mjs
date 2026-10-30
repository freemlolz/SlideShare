import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createSlideSync } from '../src/server.mjs';

test('poll HTTP and WebSocket state stays private, deduplicates cookies, and reveals results after ten seconds', async (context) => {
  const application = await createSlideSync({ port: 0, host: '127.0.0.1' });
  context.after(() => application.close());
  const base = `http://127.0.0.1:${application.port}`;
  const viewer = `?token=${application.viewerToken}`;
  const hostHeaders = { 'X-Host-Token': application.hostToken, 'Content-Type': 'application/json' };
  const request = (route, body, headers = hostHeaders) => fetch(`${base}${route}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const definition = { question: 'Що далі?', options: ['Приклади', 'Практика', 'Питання', 'Перерва'] };
  assert.equal((await request(`/api/host/polls/start${viewer}`, definition, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await request('/api/host/polls/start', { question: 'Oops', options: ['A', 'B', 'C'] })).status, 400);
  const opened = await request('/api/host/polls/start', definition).then((response) => response.json());
  const pollId = opened.poll.id;
  assert.equal(opened.poll.endsAt - opened.poll.startsAt, 10000);
  assert.equal((await request('/api/host/polls/start', definition)).status, 409);
  const initial = await fetch(`${base}/api/state${viewer}`);
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  assert.match(initial.headers.get('set-cookie'), /HttpOnly/);
  assert.match(initial.headers.get('set-cookie'), /SameSite=Strict/);
  const voteHeaders = { 'Content-Type': 'application/json', Cookie: cookie };
  assert.equal((await request('/api/polls/vote', { pollId, answer: 0 }, voteHeaders)).status, 401);
  assert.equal((await request('/api/polls/vote', { pollId, answer: 0 })).status, 403);
  assert.equal((await request(`/api/polls/vote${viewer}`, { pollId, answer: 0 }, { 'Content-Type': 'application/json' })).status, 400);
  assert.equal((await request(`/api/polls/vote${viewer}`, { pollId, answer: 4 }, voteHeaders)).status, 400);
  assert.equal((await request(`/api/polls/vote${viewer}`, { pollId: 'stale', answer: 0 }, voteHeaders)).status, 409);
  const voted = await request(`/api/polls/vote${viewer}`, { pollId, answer: 2 }, voteHeaders).then((response) => response.json());
  assert.equal(voted.poll.total, 1);
  assert.equal(voted.poll.vote, 2);
  assert.equal(voted.poll.counts, null);
  assert.equal((await request(`/api/polls/vote${viewer}`, { pollId, answer: 2 }, voteHeaders)).status, 200);
  assert.equal((await request(`/api/polls/vote${viewer}`, { pollId, answer: 1 }, voteHeaders)).status, 409);
  const reconnect = await fetch(`${base}/api/state${viewer}`, { headers: { Cookie: cookie } }).then((response) => response.json());
  assert.equal(reconnect.poll.vote, 2);
  assert.equal(reconnect.poll.total, 1);
  const outsider = await fetch(`${base}/api/state${viewer}`).then((response) => response.json());
  assert.equal(outsider.poll.vote, null);
  assert.equal(outsider.poll.counts, null);
  const hostState = await fetch(`${base}/api/state`, { headers: hostHeaders }).then((response) => response.json());
  assert.equal(hostState.poll.vote, null);
  assert.equal(hostState.poll.counts, null);

  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${application.viewerToken}`, { headers: { Cookie: cookie }, origin: base });
  context.after(() => socket.terminate());
  const states = [];
  const results = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Poll results timed out')), 13000);
    socket.on('message', (raw) => {
      const state = JSON.parse(raw.toString());
      states.push(state);
      if (state.poll?.status === 'results') { clearTimeout(timer); resolve(state); }
    });
  });
  const final = await results;
  assert.equal(final.poll.vote, 2);
  assert.deepEqual(final.poll.counts, [0, 0, 1, 0]);
  assert.ok(final.serverTime >= opened.poll.endsAt);
  assert.ok(states.filter((state) => state.poll?.status === 'open').every((state) => state.poll.counts === null && state.poll.vote === 2));
  assert.equal((await request(`/api/polls/vote${viewer}`, { pollId, answer: 0 }, voteHeaders)).status, 409);
  assert.equal((await request(`/api/host/polls/cancel${viewer}`, { pollId }, voteHeaders)).status, 403);
  assert.equal((await request('/api/host/polls/cancel', { pollId: 'old' })).status, 409);
  const dismissed = await request('/api/host/polls/cancel', { pollId }).then((response) => response.json());
  assert.equal(dismissed.poll, null);
  const replay = await request('/api/host/polls/start', definition).then((response) => response.json());
  assert.notEqual(replay.poll.id, pollId);
  assert.equal(replay.poll.total, 0);
  assert.equal((await request(`/api/polls/vote${viewer}`, { pollId, answer: 2 }, voteHeaders)).status, 409);
});

test('forged voter cookies are replaced instead of impersonating another participant', async (context) => {
  const application = await createSlideSync({ port: 0, host: '127.0.0.1' });
  context.after(() => application.close());
  const base = `http://127.0.0.1:${application.port}`;
  const initial = await fetch(`${base}/api/state?token=${application.viewerToken}`);
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  const forged = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  const response = await fetch(`${base}/api/state?token=${application.viewerToken}`, { headers: { Cookie: forged } });
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get('set-cookie').split(';')[0], cookie);
  const retained = await fetch(`${base}/api/state?token=${application.viewerToken}`, { headers: { Cookie: cookie } });
  assert.equal(retained.headers.get('set-cookie'), null);
});
