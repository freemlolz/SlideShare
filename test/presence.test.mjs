import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceRegistry, PRESENCE_LIMITS } from '../src/presence.mjs';

function fixture(limit) {
  let now = 1000;
  const registry = new PresenceRegistry({ now: () => now, limit });
  return { registry, advance: (milliseconds) => { now += milliseconds; } };
}

test('presence deduplicates browser tabs and preserves labels across reconnects', () => {
  const { registry } = fixture();
  registry.http('browser');
  registry.connect('browser', 'first-tab');
  registry.connect('browser', 'second-tab');
  assert.equal(registry.snapshot().participants.length, 1);
  assert.equal(registry.snapshot().participants[0].openSockets, 2);
  registry.disconnect('browser', 'first-tab');
  assert.equal(registry.snapshot().totals.connected, 1);
  registry.disconnect('browser', 'second-tab');
  assert.equal(registry.snapshot().totals.reconnecting, 1);
  registry.connect('browser', 'new-tab');
  assert.equal(registry.snapshot().participants[0].label, 'Учасник 1');
  assert.equal(registry.snapshot().totals.connected, 1);
});

test('presence distinguishes fallback, reconnecting and disconnected at deadline boundaries', () => {
  const { registry, advance } = fixture();
  registry.http('browser');
  assert.equal(registry.snapshot().totals.fallback, 1);
  advance(PRESENCE_LIMITS.httpFreshMs);
  assert.equal(registry.snapshot().totals.reconnecting, 1);
  advance(PRESENCE_LIMITS.disconnectedMs - PRESENCE_LIMITS.httpFreshMs);
  assert.equal(registry.snapshot().totals.disconnected, 1);
  registry.http('browser');
  assert.equal(registry.snapshot().totals.fallback, 1);
  assert.equal(registry.snapshot().participants[0].id, 1);
});

test('a stale open socket is not enough to claim connectivity and pong restores it', () => {
  const { registry, advance } = fixture();
  registry.connect('browser', 'socket');
  advance(PRESENCE_LIMITS.socketFreshMs);
  assert.equal(registry.snapshot().totals.reconnecting, 1);
  advance(10000);
  assert.equal(registry.snapshot().totals.disconnected, 1);
  registry.pong('browser', 'socket');
  assert.equal(registry.snapshot().totals.connected, 1);
  assert.equal(registry.sweep(), true);
  assert.equal(registry.sweep(), false);
});

test('a recent HTTP report after socket loss switches to fallback, not disconnected', () => {
  const { registry, advance } = fixture();
  registry.http('browser');
  registry.connect('browser', 'socket');
  registry.disconnect('browser', 'socket');
  assert.equal(registry.snapshot().totals.reconnecting, 1);
  registry.http('browser');
  assert.equal(registry.snapshot().totals.fallback, 1);
  advance(9000);
  registry.http('browser');
  advance(9000);
  assert.equal(registry.snapshot().totals.fallback, 1);
});

test('preloading reflects active tabs, reloads, HTTP progress and deck replacement', () => {
  const { registry } = fixture();
  const deck = { id: 'deck', pages: [{}, {}] };
  registry.connect('browser', 'ready-tab');
  registry.ready('browser', { deckId: 'deck', loaded: 2 }, 'ready-tab');
  registry.connect('browser', 'loading-tab');
  assert.equal(registry.snapshot(deck).participants[0].loaded, 2);
  registry.disconnect('browser', 'ready-tab');
  assert.equal(registry.snapshot(deck).participants[0].loaded, 0);
  registry.ready('browser', { deckId: 'deck', loaded: 1 }, 'loading-tab');
  assert.equal(registry.snapshot(deck).participants[0].loaded, 1);
  assert.equal(registry.snapshot({ ...deck, id: 'new' }).participants[0].loaded, 0);
  registry.disconnect('browser', 'loading-tab');
  registry.ready('browser', { deckId: 'deck', loaded: 0 });
  assert.equal(registry.snapshot(deck).participants[0].loaded, 0);
  registry.ready('browser', { deckId: 'deck', loaded: 2 });
  assert.equal(registry.snapshot(deck).participants[0].loaded, 2);
});

test('registry is bounded, removes only disconnected entries and hides browser identities', () => {
  const { registry, advance } = fixture(2);
  assert.equal(registry.http('private-cookie-id'), true);
  assert.equal(registry.http('other-cookie-id'), true);
  assert.equal(registry.http('overflow'), false);
  assert.equal(registry.connect('overflow', 'socket'), false);
  assert.throws(() => registry.remove(1), { status: 409 });
  assert.throws(() => registry.remove('1'), { status: 404 });
  assert.doesNotMatch(JSON.stringify(registry.snapshot()), /cookie-id/);
  advance(35000);
  registry.remove(1);
  assert.equal(registry.http('overflow'), true);
  assert.deepEqual(registry.snapshot().participants.map((entry) => entry.id), [2, 3]);
});

test('contact after removing a stale record recreates a participant without retaining the old label', () => {
  const { registry, advance } = fixture();
  registry.connect('browser', 'socket');
  advance(35000);
  registry.remove(1);
  registry.pong('browser', 'socket');
  assert.equal(registry.snapshot().participants[0].id, 2);
  assert.equal(registry.snapshot().totals.connected, 1);
});
