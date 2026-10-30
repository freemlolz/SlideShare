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
test.beforeEach(async () => {
  const state = await fetch(`${base}/api/state`, { headers: { 'X-Host-Token': application.hostToken } }).then((response) => response.json());
  if (state.poll) await fetch(`${base}/api/host/polls/cancel`, { method: 'POST', headers: { 'X-Host-Token': application.hostToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ pollId: state.poll.id }) });
});

async function savePoll(host, options = ['Приклади', 'Практика']) {
  await host.locator('#poll-new').click();
  await host.locator('#poll-question').fill('Що обговоримо далі?');
  await host.locator('#poll-options-count').selectOption(String(options.length));
  for (const [index, answer] of options.entries()) await host.locator(`#poll-option-${index}`).fill(answer);
  await host.locator('#poll-save').click();
}

test('presenter creates, edits, copies, deletes, and retains polls on reload', async ({ page }) => {
  await page.goto(application.hostUrl);
  await savePoll(page);
  await expect(page.locator('.poll-card')).toHaveCount(1);
  await page.locator('.poll-edit').click();
  await page.locator('#poll-question').fill('Оновлене запитання');
  await page.locator('#poll-options-count').selectOption('4');
  await page.locator('#poll-option-2').fill('Питання');
  await page.locator('#poll-option-3').fill('Перерва');
  await page.locator('#poll-save').click();
  await expect(page.locator('.poll-card h3')).toHaveText('Оновлене запитання');
  await expect(page.locator('.poll-card')).toContainText('4 відповіді');
  await page.reload();
  await expect(page.locator('.poll-card h3')).toHaveText('Оновлене запитання');
  await page.locator('.poll-duplicate').click();
  await expect(page.locator('.poll-card')).toHaveCount(2);
  await page.locator('#poll-discard').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.poll-delete').last().click();
  await expect(page.locator('.poll-card')).toHaveCount(1);
  await page.locator('.poll-edit').click();
  await page.locator('#poll-option-1').fill('Приклади');
  await page.locator('#poll-save').click();
  await expect(page.locator('#poll-editor-error')).toBeVisible();
});

test('four-choice poll votes once per browser and automatically shows results on laptop and phones', async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const secondContext = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const host = await hostContext.newPage();
  const phone = await phoneContext.newPage();
  const second = await secondContext.newPage();
  const errors = [];
  for (const page of [host, phone, second]) page.on('pageerror', (error) => errors.push(error.message));
  try {
    const body = new FormData();
    body.append('pdf', new Blob([makePdf(2)]), 'poll-demo.pdf');
    await fetch(`${base}/api/host/pdf`, { method: 'POST', headers: { 'X-Host-Token': application.hostToken }, body });
    await host.goto(application.hostUrl);
    await phone.goto(`${base}/join#token=${application.viewerToken}`);
    await second.routeWebSocket('**/ws?*', (socket) => socket.close());
    await second.goto(`${base}/join#token=${application.viewerToken}`);
    await savePoll(host, ['Приклади', 'Практика', 'Питання', 'Перерва']);
    await host.locator('.poll-start').click();
    await expect(phone.locator('#viewer-poll')).toBeVisible();
    await expect(second.locator('#viewer-poll')).toBeVisible();
    await expect(phone.locator('.poll-answer')).toHaveCount(4);
    await expect(phone.locator('.poll-result').first()).toBeHidden();
    await phone.locator('[data-answer="1"]').click();
    await expect(phone.locator('.poll-status')).toContainText('Ваш голос зараховано');
    await expect(phone.locator('[data-answer="0"]')).toBeDisabled();
    await phone.reload();
    await expect(phone.locator('[data-answer="1"]')).toHaveAttribute('aria-pressed', 'true');
    await second.locator('[data-answer="3"]').click();
    await expect(second.locator('.poll-status')).toContainText('Ваш голос зараховано');
    await expect(host.locator('.poll-total')).toHaveText('Голосів: 2');
    await host.screenshot({ path: `test-results/${test.info().project.name}-poll-host.png`, fullPage: true });
    await phone.screenshot({ path: `test-results/${test.info().project.name}-poll-phone.png`, fullPage: true });
    await expect(host.locator('#host-poll')).toHaveAttribute('data-phase', 'results', { timeout: 12000 });
    for (const page of [phone, second]) {
      await expect(page.locator('#viewer-poll')).toHaveAttribute('data-phase', 'results');
      await expect(page.locator('[data-answer="1"] .poll-result')).toContainText('1 · 50%');
      await expect(page.locator('[data-answer="3"] .poll-result')).toContainText('1 · 50%');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await phone.screenshot({ path: `test-results/${test.info().project.name}-poll-results.png`, fullPage: true });
    await host.locator('.poll-dismiss').click({ delay: 250 });
    await expect(phone.locator('#viewer-poll')).toBeHidden();
    await expect(phone.locator('#slide-image')).toBeVisible();
    await expect(host.locator('#next')).toBeEnabled();
    expect(errors).toEqual([]);
  } finally { await hostContext.close(); await phoneContext.close(); await secondContext.close(); }
});

test('two-choice polls work without a PDF and cancellation returns to the waiting screen', async ({ browser }) => {
  const isolated = await createSlideSync({ port: 0, host: '127.0.0.1' });
  const context = await browser.newContext();
  const host = await context.newPage();
  const phone = await context.newPage();
  try {
    await host.goto(isolated.hostUrl);
    await phone.goto(`http://127.0.0.1:${isolated.port}/join#token=${isolated.viewerToken}`);
    await savePoll(host);
    await host.locator('.poll-start').click();
    await expect(phone.locator('.poll-answer')).toHaveCount(2);
    await expect(phone.locator('#empty')).toBeHidden();
    host.once('dialog', (dialog) => dialog.accept());
    await host.locator('.poll-dismiss').click();
    await expect(phone.locator('#viewer-poll')).toBeHidden();
    await expect(phone.locator('#empty')).toBeVisible();
  } finally { await context.close(); await isolated.close(); }
});

test('a delayed vote from a cancelled round does not disable a replacement poll', async ({ page }) => {
  await page.goto(`${base}/join#token=${application.viewerToken}`);
  const headers = { 'X-Host-Token': application.hostToken, 'Content-Type': 'application/json' };
  const command = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(response.ok).toBeTruthy();
    return response.json();
  };
  const first = await command('/api/host/polls/start', { question: 'Перший раунд', options: ['Так', 'Ні'] });
  let release;
  let markRequested;
  const gate = new Promise((resolve) => { release = resolve; });
  const requested = new Promise((resolve) => { markRequested = resolve; });
  await page.route('**/api/polls/vote?*', async (route) => { markRequested(); await gate; await route.continue(); });
  try {
    await page.locator('[data-answer="0"]').click();
    await requested;
    await expect(page.locator('[data-answer="1"]')).toBeDisabled();
    await command('/api/host/polls/cancel', { pollId: first.poll.id });
    await command('/api/host/polls/start', { question: 'Новий раунд', options: ['Далі', 'Назад'] });
    await expect(page.locator('#viewer-poll-question')).toHaveText('Новий раунд');
    await expect(page.locator('[data-answer="0"]')).toBeEnabled();
    await expect(page.locator('[data-answer="1"]')).toBeEnabled();
    const completed = page.waitForResponse((response) => response.url().includes('/api/polls/vote?'));
    release();
    await completed;
    await expect(page.locator('#error')).toBeHidden();
    await expect(page.locator('#viewer-poll-question')).toHaveText('Новий раунд');
    await expect(page.locator('[data-answer="0"]')).toBeEnabled();
  } finally { release(); }
});
