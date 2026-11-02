import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, chromium, expect } from '@playwright/test';
import { makePdf } from '../../scripts/create-demo.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const executablePath = process.env.SLIDESYNC_DESKTOP_EXECUTABLE;
const { ELECTRON_RUN_AS_NODE, ...environment } = process.env;
const sessionDirectories = async () => (await readdir(tmpdir())).filter((name) => /^slidesync-[a-zA-Z0-9]+$/.test(name));

async function quit(application) {
  const closed = application.waitForEvent('close');
  await application.evaluate(async ({ app, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    setImmediate(() => app.quit());
  });
  await closed;
}

test('desktop starts, renders PDF, syncs phones, persists polls across origins, and cleans up on quit', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'slidesync-desktop-test-'));
  const baseline = await sessionDirectories();
  let application;
  let browser;
  try {
    const launch = () => electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: [...(executablePath ? [] : [root]), `--user-data-dir=${directory}`],
      env: environment, timeout: 30_000,
    });
    application = await launch();
    const page = await application.firstWindow();
    await page.locator('#desktop-status').waitFor({ state: 'visible' });
    await page.getByText('Синхронізовано', { exact: true }).waitFor();
    const origin = new URL(page.url()).origin;
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), directory);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
    const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.isPersistent()), false);
    await page.locator('#pdf').setInputFiles({ name: 'desktop-demo.pdf', mimeType: 'application/pdf', buffer: makePdf() });
    await page.locator('#upload').click();
    await page.locator('#slide-image').waitFor({ state: 'visible', timeout: 30_000 });
    const joinUrl = await page.locator('#join-url').getAttribute('href');
    const viewerToken = new URL(joinUrl).hash.slice('#token='.length);
    browser = await chromium.launch();
    const viewer = await browser.newPage();
    await viewer.goto(`${origin}/join#token=${viewerToken}`);
    await viewer.locator('#slide-image').waitFor({ state: 'visible' });
    await expect(viewer.locator('#preload')).toHaveText('Усі 5 слайдів завантажено');
    await page.locator('#next').click();
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 2 / 5');
    await page.locator('#poll-new').click();
    await page.locator('#poll-question').fill('Desktop beta?');
    await page.locator('#poll-option-0').fill('Yes');
    await page.locator('#poll-option-1').fill('No');
    await page.locator('#poll-save').click();
    await page.getByText('Опитування збережено на цьому комп’ютері.', { exact: true }).waitFor();
    const persisted = JSON.parse(await readFile(path.join(directory, 'desktop-state.json'), 'utf8'));
    assert.equal(persisted.polls[0].question, 'Desktop beta?');
    await page.screenshot({ path: path.join(root, 'test-results/desktop-beta.png'), fullPage: true });
    const storage = (await sessionDirectories()).filter((name) => !baseline.includes(name));
    await quit(application);
    application = null;
    for (const name of storage) await assert.rejects(access(path.join(tmpdir(), name)));
    assert.equal(await fetch(`${origin}/api/state`).then(() => false, () => true), true);
    const http = await import('node:http');
    const occupied = http.createServer((request, response) => response.end('occupied'));
    await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(persisted.port, '0.0.0.0', resolve); });
    try {
      application = await launch();
      const reopened = await application.firstWindow();
      await reopened.locator('#poll-list').getByText('Desktop beta?', { exact: true }).waitFor();
      await reopened.getByText('Синхронізовано', { exact: true }).waitFor();
      assert.notEqual(new URL(reopened.url()).origin, origin);
      assert.equal(await reopened.locator('#slide-image').isVisible(), false);
      const created = (await sessionDirectories()).filter((name) => !baseline.includes(name));
      await quit(application);
      application = null;
      for (const name of created) await assert.rejects(access(path.join(tmpdir(), name)));
    } finally { await new Promise((resolve) => occupied.close(resolve)); }
  } finally {
    await browser?.close();
    if (application) await quit(application).catch(() => application.close());
    await rm(directory, { recursive: true, force: true });
  }
});
