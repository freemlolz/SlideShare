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

test('host PDF upload, two synced phones, full preloading, reconnect and deck replacement', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const host = await hostContext.newPage();
  const viewer = await viewerContext.newPage();
  const secondViewer = await viewerContext.newPage();
  const errors = [];
  for (const page of [host, viewer, secondViewer]) page.on('pageerror', (error) => errors.push(error.message));
  try {
    await host.goto(application.hostUrl);
    await expect(host.locator('#connection')).toHaveText('Синхронізовано');
    await viewer.goto(`${base}/join#token=${application.viewerToken}`);
    await expect(viewer.locator('#empty')).toContainText('готує презентацію');
    await host.locator('#pdf').setInputFiles({ name: 'Demo.pdf', mimeType: 'application/pdf', buffer: makePdf() });
    await host.getByRole('button', { name: 'Завантажити PDF' }).click();
    await expect(viewer.locator('#slide-image')).toBeVisible();
    await expect(viewer.locator('#preload')).toHaveText('Усі 5 слайдів завантажено');
    await secondViewer.goto(`${base}/join#token=${application.viewerToken}`);
    await expect(secondViewer.locator('#preload')).toHaveText('Усі 5 слайдів завантажено');
    await expect(host.locator('#participants')).toHaveText('2');
    await expect(host.locator('#ready')).toHaveText('2');
    let furtherSlideRequests = 0;
    viewer.on('request', (request) => { if (request.url().includes('/slides/')) furtherSlideRequests += 1; });
    const firstSlide = await viewer.locator('#slide-image').getAttribute('src');
    await host.getByRole('button', { name: 'Наступний слайд' }).click();
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 2 / 5');
    await expect(secondViewer.locator('#page-label')).toHaveText('Слайд 2 / 5');
    await expect(viewer.locator('#slide-image')).toHaveJSProperty('naturalWidth', 1600);
    await expect(viewer.locator('#slide-image')).not.toHaveAttribute('src', firstSlide);
    expect(furtherSlideRequests).toBe(0);
    const secondSlide = await viewer.locator('#slide-image').getAttribute('src');
    await viewerContext.setOffline(true);
    await host.locator('#slide-number').fill('4');
    await host.locator('#slide-number').press('Enter');
    await host.locator('#slide-number').blur();
    await expect(host.locator('#slide-number')).toHaveValue('4');
    await viewerContext.setOffline(false);
    await viewer.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 4 / 5');
    await expect(viewer.locator('#slide-image')).not.toHaveAttribute('src', secondSlide);
    await viewer.reload();
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 4 / 5');
    await expect(viewer.locator('#preload')).toHaveText('Усі 5 слайдів завантажено');
    await host.screenshot({ path: `test-results/${test.info().project.name}-host.png`, fullPage: true });
    await viewer.screenshot({ path: `test-results/${test.info().project.name}-phone.png`, fullPage: true });
    await host.locator('#pdf').setInputFiles({ name: 'Replacement.pdf', mimeType: 'application/pdf', buffer: makePdf(2) });
    await host.getByRole('button', { name: 'Завантажити PDF' }).click();
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 1 / 2');
    await expect(viewer.locator('#preload')).toHaveText('Усі 2 слайдів завантажено');
    expect(errors).toEqual([]);
  } finally { await hostContext.close(); await viewerContext.close(); }
});

test('viewer remains usable through HTTP polling when WebSockets fail', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const body = new FormData();
  body.append('pdf', new Blob([makePdf(3)]), 'poll.pdf');
  const uploaded = await fetch(`${base}/api/host/pdf`, { method: 'POST', headers: { 'X-Host-Token': application.hostToken }, body }).then((response) => response.json());
  await page.routeWebSocket('**/ws?**', (socket) => socket.close());
  try {
    await page.goto(`${base}/join#token=${application.viewerToken}`);
    await expect(page.locator('#preload')).toHaveText('Усі 3 слайдів завантажено');
    await fetch(`${base}/api/host/slide`, { method: 'POST', headers: { 'X-Host-Token': application.hostToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ deckId: uploaded.deck.id, index: 2 }) });
    await expect(page.locator('#page-label')).toHaveText('Слайд 3 / 3');
    await expect(page.locator('#slide-image')).toBeVisible();
  } finally { await context.close(); }
});

test('missing viewer token gives actionable instructions', async ({ page }) => {
  await page.goto(`${base}/join`);
  await expect(page.locator('#error')).toContainText('повне посилання');
  await expect(page.locator('#empty')).toContainText('QR-код');
});
