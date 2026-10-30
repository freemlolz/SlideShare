import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readApiResponse } from '../public/api.js';

test('API reader explains stale-server HTML responses instead of leaking JSON parser errors', async () => {
  const response = new Response('<!DOCTYPE html><html>Cannot POST /api/host/polls/start</html>', {
    status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  await assert.rejects(readApiResponse(response), (error) => {
    assert.match(error.message, /Перезапустіть SlideSync Local/);
    assert.doesNotMatch(error.message, /Unexpected token|DOCTYPE/);
    return true;
  });
});

test('API reader handles successful JSON and preserves server error messages', async () => {
  assert.deepEqual(await readApiResponse(Response.json({ poll: null })), { poll: null });
  await assert.rejects(readApiResponse(Response.json({ error: 'Немає доступу.' }, { status: 403 })), /Немає доступу/);
  await assert.rejects(readApiResponse(new Response('broken', { headers: { 'Content-Type': 'application/json' } })), /Не вдалося прочитати/);
  await assert.rejects(readApiResponse(new Response('Unavailable', { status: 503 })), /503/);
});
