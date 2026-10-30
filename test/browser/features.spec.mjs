import { test, expect } from '@playwright/test';
import { createSlideSync } from '../../src/server.mjs';
import { makePdf } from '../../scripts/create-demo.mjs';

let application;
let base;
test.beforeAll(async () => {
  application = await createSlideSync({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${application.port}`;
});
test.afterAll(async () => { await application.close(); });

async function api(route, body) {
  const response = await fetch(`${base}${route}`, { method: body ? 'POST' : 'GET',
    headers: { 'X-Host-Token': application.hostToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  expect(response.ok).toBeTruthy();
  return response.json();
}

async function upload(pages = 5, options) {
  const body = new FormData();
  body.append('pdf', new Blob([makePdf(pages, options)]), 'features.pdf');
  const response = await fetch(`${base}/api/host/pdf`, { method: 'POST', headers: { 'X-Host-Token': application.hostToken }, body });
  expect(response.ok).toBeTruthy();
  return response.json();
}

async function draw(page, vertical = 0.45, whileDrawing) {
  const box = await page.locator('#annotations').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * vertical);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * (vertical + 0.08), { steps: 12 });
  await whileDrawing?.();
  await page.mouse.up();
}

async function hasInk(page) {
  return page.locator('#annotations').evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
    return false;
  });
}

async function maximumAlpha(page) {
  return page.locator('#annotations').evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let alpha = 0;
    for (let index = 3; index < pixels.length; index += 4) alpha = Math.max(alpha, pixels[index]);
    return alpha;
  });
}

test('presenter ink syncs all tools, clears, expires and resets on slide changes', async ({ browser }) => {
  await upload();
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const host = await hostContext.newPage();
  const phone = await phoneContext.newPage();
  const errors = [];
  for (const page of [host, phone]) page.on('pageerror', (error) => errors.push(error.message));
  try {
    await host.goto(application.hostUrl);
    await phone.goto(`${base}/join#token=${application.viewerToken}`);
    await expect(host.locator('#slide-image')).toBeVisible();
    await expect(phone.locator('#slide-image')).toBeVisible();
    await host.locator('#draw-toggle').click();
    await host.locator('#draw-lifetime').selectOption('0');
    for (const [index, tool] of ['pencil', 'brush', 'marker'].entries()) {
      await host.locator('#draw-tool').selectOption(tool);
      await host.locator('#draw-size').selectOption(['3', '12', '20'][index]);
      await draw(host, 0.25 + index * 0.2, index === 0
        ? () => expect(phone.locator('#annotations')).toHaveAttribute('data-stroke-count', '1') : undefined);
      await expect(phone.locator('#annotations')).toHaveAttribute('data-stroke-count', String(index + 1));
    }
    await expect.poll(() => hasInk(phone)).toBe(true);
    const saved = await api('/api/state');
    expect(saved.annotations.strokes.map((stroke) => stroke.tool)).toEqual(['pencil', 'brush', 'marker']);
    expect(saved.annotations.strokes.map((stroke) => stroke.size)).toEqual([3, 12, 20]);
    await expect.poll(async () => (await api('/api/state')).annotations.strokes.every((stroke) => stroke.finished)).toBe(true);
    await host.setViewportSize({ width: 950, height: 1100 });
    await expect.poll(() => hasInk(host)).toBe(true);
    await host.setViewportSize({ width: 1440, height: 1050 });
    await host.screenshot({ path: `test-results/${test.info().project.name}-drawing-host.png` });
    await phone.screenshot({ path: `test-results/${test.info().project.name}-drawing-phone.png`, fullPage: true });
    await host.locator('#draw-clear').click();
    await expect(phone.locator('#annotations')).toHaveAttribute('data-stroke-count', '0');
    await expect.poll(() => hasInk(phone)).toBe(false);
    await host.locator('#draw-lifetime').selectOption('5000');
    await draw(host);
    await expect(phone.locator('#annotations')).toHaveAttribute('data-stroke-count', '1');
    const initialAlpha = await maximumAlpha(phone);
    expect(initialAlpha).toBeGreaterThan(0);
    await expect.poll(async () => {
      const alpha = await maximumAlpha(phone);
      return alpha > 0 && alpha < initialAlpha;
    }, { timeout: 6500, intervals: [50, 100, 100] }).toBe(true);
    await expect(phone.locator('#annotations')).toHaveAttribute('data-stroke-count', '0', { timeout: 8000 });
    await host.locator('#draw-lifetime').selectOption('0');
    await draw(host);
    await expect(phone.locator('#annotations')).toHaveAttribute('data-stroke-count', '1');
    await host.locator('#next').click();
    await expect(phone.locator('#page-label')).toHaveText('Слайд 2 / 5');
    await expect(phone.locator('#annotations')).toHaveAttribute('data-stroke-count', '0');
    await host.locator('#previous').click();
    await expect(phone.locator('#page-label')).toHaveText('Слайд 1 / 5');
    await expect(phone.locator('#annotations')).toHaveAttribute('data-stroke-count', '0');
    expect(errors).toEqual([]);
  } finally { await hostContext.close(); await phoneContext.close(); }
});

test('phone browsing is independent, stays pinned, and can rejoin the presenter', async ({ browser }) => {
  const initial = await upload();
  await api('/api/host/slide', { deckId: initial.deck.id, index: 3 });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const first = await context.newPage();
  const second = await context.newPage();
  try {
    for (const page of [first, second]) await page.goto(`${base}/join#token=${application.viewerToken}`);
    await expect(first.locator('#page-label')).toHaveText('Слайд 4 / 5');
    await first.locator('#viewer-previous').click();
    await expect(first.locator('#page-label')).toHaveText('Слайд 3 / 5');
    await expect(first.locator('#follow-status')).toContainText('Перегляд історії');
    await expect(second.locator('#page-label')).toHaveText('Слайд 4 / 5');
    expect((await api('/api/state')).slide).toBe(3);
    const live = await api('/api/host/slide', { deckId: initial.deck.id, index: 4 });
    await api('/api/host/annotations', { action: 'append', deckId: initial.deck.id, index: 4,
      epoch: live.annotations.epoch, id: 'live-ink', tool: 'brush', size: 12, color: '#ef4444', lifetime: 0,
      points: [[0.3, 0.4, 0.6], [0.6, 0.5, 0.9]], finished: true });
    await expect(second.locator('#page-label')).toHaveText('Слайд 5 / 5');
    await expect(second.locator('#annotations')).toHaveAttribute('data-stroke-count', '1');
    await expect(first.locator('#page-label')).toHaveText('Слайд 3 / 5');
    await expect(first.locator('#follow-status')).toContainText('ведучий: 5');
    await expect(first.locator('#annotations')).toHaveAttribute('data-stroke-count', '0');
    await first.locator('#viewer-next').click();
    await expect(first.locator('#page-label')).toHaveText('Слайд 4 / 5');
    await first.locator('#go-live').click();
    await expect(first.locator('#page-label')).toHaveText('Слайд 5 / 5');
    await expect(first.locator('#annotations')).toHaveAttribute('data-stroke-count', '1');
    await expect(first.locator('#go-live')).toBeDisabled();
    await api('/api/host/slide', { deckId: initial.deck.id, index: 1 });
    await expect(first.locator('#page-label')).toHaveText('Слайд 2 / 5');
    await first.locator('#viewer-previous').click();
    await upload(2);
    await expect(first.locator('#page-label')).toHaveText('Слайд 1 / 2');
    await expect(first.locator('#follow-status')).toHaveText('Разом із ведучим');
    await expect(first.locator('#go-live')).toBeDisabled();
  } finally { await context.close(); }
});

test('drawing coordinates respect portrait-page letterboxing', async ({ browser }) => {
  await upload(1, { rotation: 90 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.goto(application.hostUrl);
    await expect(page.locator('#slide-image')).toHaveJSProperty('naturalHeight', 1600);
    await page.locator('#draw-toggle').click();
    const box = await page.locator('#annotations').boundingBox();
    await page.mouse.click(box.x + box.width * 0.05, box.y + box.height * 0.5);
    expect((await api('/api/state')).annotations.strokes).toHaveLength(0);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect.poll(async () => (await api('/api/state')).annotations.strokes.length).toBe(1);
    const [stroke] = (await api('/api/state')).annotations.strokes;
    expect(stroke.points[0][0]).toBeCloseTo(0.5, 2);
    expect(stroke.points[0][1]).toBeCloseTo(0.5, 2);
    await expect.poll(() => hasInk(page)).toBe(true);
  } finally { await context.close(); }
});

test('returning to live cancels a delayed historical image without reverting the screen', async ({ browser }) => {
  const initial = await upload();
  await api('/api/host/slide', { deckId: initial.deck.id, index: 3 });
  const context = await browser.newContext();
  const page = await context.newPage();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/slides/*/3.jpg?*', async (route) => { await gate; await route.continue(); });
  try {
    await page.goto(`${base}/join#token=${application.viewerToken}`);
    await expect(page.locator('#slide-image')).toHaveAttribute('data-slide-index', '3');
    await page.locator('#viewer-previous').click();
    await expect(page.locator('#page-label')).toHaveText('Слайд 3 / 5');
    await page.locator('#go-live').click();
    release();
    await expect(page.locator('#preload')).toHaveText('Усі 5 слайдів завантажено');
    await expect(page.locator('#page-label')).toHaveText('Слайд 4 / 5');
    await expect(page.locator('#slide-image')).toHaveAttribute('data-slide-index', '3');
  } finally { release(); await context.close(); }
});
