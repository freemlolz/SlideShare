import { test, expect } from '@playwright/test';
import { createSlideSync } from '../../src/server.mjs';

let application;
let base;
test.beforeAll(async () => {
  application = await createSlideSync({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${application.port}`;
});
test.afterAll(async () => { await application.close(); });
test.beforeEach(async () => {
  const state = await fetch(`${base}/api/state`, { headers: { 'X-Host-Token': application.hostToken } }).then((response) => response.json());
  if (state.poll) await fetch(`${base}/api/host/polls/cancel`, { method: 'POST',
    headers: { 'X-Host-Token': application.hostToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ pollId: state.poll.id }) });
});

async function savePoll(host, question) {
  await host.locator('#poll-new').click();
  await host.locator('#poll-question').fill(question);
  await host.locator('#poll-option-0').fill('Так');
  await host.locator('#poll-option-1').fill('Ні');
  await host.locator('#poll-save').click();
}

test('private draggable launcher starts saved polls in fullscreen and returns to slides', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const host = await hostContext.newPage();
  const phone = await phoneContext.newPage();
  const errors = [];
  for (const page of [host, phone]) page.on('pageerror', (error) => errors.push(error.message));
  try {
    await host.goto(application.hostUrl);
    await phone.goto(`${base}/join#token=${application.viewerToken}`);
    await savePoll(host, 'Почнемо практику?');
    await savePoll(host, 'Наступне приватне питання');
    await expect(host.locator('.poll-launcher-count')).toHaveText('2');
    await expect(phone.locator('#poll-launcher')).toHaveCount(0);
    await expect(phone.locator('body')).not.toContainText('Наступне приватне питання');
    await host.locator('#poll-launcher-toggle').click();
    await expect(host.locator('.poll-launcher-item')).toHaveCount(2);
    const before = await host.locator('#poll-launcher').boundingBox();
    const handle = await host.locator('.poll-launcher-handle').boundingBox();
    await host.mouse.move(handle.x + 60, handle.y + 20);
    await host.mouse.down();
    await host.mouse.move(handle.x - 120, handle.y - 100, { steps: 5 });
    await host.mouse.up();
    const after = await host.locator('#poll-launcher').boundingBox();
    expect(after.x).toBeLessThan(before.x - 80);
    await host.locator('#poll-launcher-close').click();
    const supportsFullscreen = await host.evaluate(() => typeof document.documentElement.requestFullscreen === 'function');
    if (supportsFullscreen) {
      await host.locator('#fullscreen').click();
      await expect.poll(() => host.evaluate(() => document.fullscreenElement?.id)).toBe('presentation-screen');
    }
    await host.locator('#poll-launcher-toggle').click();
    await expect(host.locator('#poll-launcher-panel')).toBeVisible();
    await host.screenshot({ path: `test-results/${test.info().project.name}-poll-launcher.png` });
    await host.locator('.poll-launcher-start').first().click();
    await expect(host.locator('#poll-launcher-panel')).toBeHidden();
    await expect(phone.locator('#viewer-poll-question')).toHaveText('Почнемо практику?');
    await phone.locator('[data-answer="0"]').click();
    await expect(phone.locator('.poll-status')).toContainText('Ваш голос зараховано');
    await host.locator('#poll-launcher-toggle').click();
    await expect(host.locator('.poll-launcher-start').first()).toBeDisabled();
    await expect(host.locator('.poll-launcher-return')).toBeVisible({ timeout: 12000 });
    await expect(phone.locator('#viewer-poll')).toHaveAttribute('data-phase', 'results');
    await host.locator('.poll-launcher-return').click({ delay: 250 });
    await expect(phone.locator('#viewer-poll')).toBeHidden();
    await host.locator('#poll-launcher-toggle').click();
    await host.locator('.poll-launcher-manage').click();
    await expect.poll(() => host.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await expect(host.locator('#poll-new')).toBeFocused();
    expect(errors).toEqual([]);
  } finally { await hostContext.close(); await phoneContext.close(); }
});

test('HTML errors from an outdated server show restart guidance without losing saved polls', async ({ page }) => {
  await page.goto(application.hostUrl);
  await savePoll(page, 'Збережене питання');
  await page.route('**/api/host/polls/start', (route) => route.fulfill({ status: 404,
    contentType: 'text/html', body: '<!DOCTYPE html><html>Cannot POST /api/host/polls/start</html>' }));
  await page.locator('#poll-launcher-toggle').click();
  await page.locator('.poll-launcher-start').click();
  await expect(page.locator('.poll-launcher-error')).toContainText('Перезапустіть SlideSync Local');
  await expect(page.locator('.poll-launcher-error')).not.toContainText('Unexpected token');
  await expect(page.locator('.poll-launcher-start')).toBeEnabled();
  await page.locator('#poll-launcher-close').click();
  await page.locator('.poll-start').click();
  await expect(page.locator('#poll-library-message')).toContainText('Перезапустіть SlideSync Local');
  await page.reload();
  await expect(page.locator('.poll-card h3')).toHaveText('Збережене питання');
});

test('an old server snapshot is identified before attempting a poll launch', async ({ page }) => {
  await page.routeWebSocket('**/ws?*', (socket) => socket.close());
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    delete state.poll;
    await route.fulfill({ response, json: state });
  });
  await page.goto(application.hostUrl);
  await savePoll(page, 'Після оновлення');
  await expect(page.locator('#error')).toContainText('Сервер запущений до оновлення');
  await page.locator('.poll-start').click();
  await expect(page.locator('#poll-library-message')).toContainText('Перезапустіть SlideSync Local');
  await page.locator('#poll-launcher-toggle').click();
  await expect(page.locator('.poll-launcher-start')).toBeDisabled();
});
