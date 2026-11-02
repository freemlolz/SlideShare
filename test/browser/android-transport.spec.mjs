import { test, expect } from '@playwright/test';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { createSlideSync } from '../../src/server.mjs';
import { makePdf } from '../../scripts/create-demo.mjs';

test('viewer uses an advertised Android WebSocket port and retains preload and history', async ({ browser }) => {
  const application = await createSlideSync({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${application.port}`;
  const proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(proxy, 'listening');
  const upstreams = [];
  proxy.on('connection', (connection, request) => {
    const upstream = new WebSocket(`${base.replace('http:', 'ws:')}/ws?role=viewer&token=${application.viewerToken}`, {
      origin: base, headers: { Cookie: request.headers.cookie ?? '' },
    });
    upstreams.push(upstream);
    const pending = [];
    connection.on('message', (message) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(message); else pending.push(message); });
    upstream.on('open', () => { for (const message of pending) upstream.send(message); });
    upstream.on('message', (message) => { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ ...JSON.parse(message.toString()), websocketPort: proxy.address().port })); });
    upstream.on('error', () => connection.close());
    upstream.on('close', () => connection.close());
    connection.on('close', () => upstream.terminate());
  });
  const context = await browser.newContext();
  try {
    const viewer = await context.newPage();
    await viewer.route('**/api/state?*', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), websocketPort: proxy.address().port } });
    });
    const body = new FormData();
    body.append('pdf', new Blob([makePdf()], { type: 'application/pdf' }), 'android-transport.pdf');
    const uploaded = await fetch(`${base}/api/host/pdf`, { method: 'POST', headers: { 'X-Host-Token': application.hostToken }, body });
    const state = await uploaded.json();
    expect(uploaded.ok).toBe(true);
    await viewer.goto(`${base}/join#token=${application.viewerToken}`);
    await expect(viewer.locator('#connection')).toHaveText('Синхронізовано');
    await expect(viewer.locator('#preload')).toHaveText('Усі 5 слайдів завантажено');
    expect(proxy.clients.size).toBe(1);
    const changed = await fetch(`${base}/api/host/slide`, { method: 'POST', headers: { 'X-Host-Token': application.hostToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ deckId: state.deck.id, index: 1 }) });
    expect(changed.ok).toBe(true);
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 2 / 5');
    await viewer.locator('#viewer-previous').click();
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 1 / 5');
    await viewer.locator('#go-live').click();
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 2 / 5');
  } finally {
    await context.close();
    for (const upstream of upstreams) upstream.terminate();
    for (const connection of proxy.clients) connection.terminate();
    await new Promise((resolve) => proxy.close(resolve));
    await application.close();
  }
});
