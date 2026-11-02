import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = process.env.ANDROID_HOME || path.join(homedir(), 'Library/Android/sdk');
const adb = path.join(sdk, 'platform-tools/adb');
const serial = process.env.ANDROID_SERIAL;
if (!/^emulator-\d+$/.test(serial ?? '')) throw new Error('Set ANDROID_SERIAL to a disposable emulator, not a personal phone.');
const command = (args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!command(['emu', 'avd', 'name']).includes('SlideSyncTest')) throw new Error('This test requires a disposable AVD named SlideSyncTest.');
const packageName = 'io.github.freemlolz.slidesync';
const instrumentation = `${packageName}.test/androidx.test.runner.AndroidJUnitRunner`;
command(['shell', 'run-as', packageName, 'rm', '-f', 'cache/browser-harness.json', 'cache/browser-harness-command']);
console.log('Starting isolated Android presenter harness.');
const instrument = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'class',
  `${packageName}.SessionTest#foregroundLifecycleAndOptionalBrowserHarness`, '-e', 'browserHarness', 'true', instrumentation]);
let output = '';
instrument.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-30_000); });
instrument.stderr.on('data', (chunk) => { output = (output + chunk.toString()).slice(-30_000); });
let finished = false;
const complete = new Promise((resolve) => instrument.once('exit', (code) => { finished = true; resolve(code); }));
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function send(value) {
  if (!['slide:0', 'slide:1', 'slide:2', 'stop'].includes(value)) throw new Error('Invalid harness command.');
  command(['shell', `run-as ${packageName} sh -c 'printf %s ${value} > cache/browser-harness-command'`]);
}
let connection;
const forwarded = [];
let browser;
try {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !finished) {
    try { connection = JSON.parse(command(['shell', 'run-as', packageName, 'cat', 'cache/browser-harness.json'])); break; }
    catch { await pause(500); }
  }
  if (!connection) throw new Error(`Android presenter failed to start:\n${output}`);
  console.log('Android presenter ready; connecting browser viewers.');
  for (const port of [connection.port, connection.websocketPort]) {
    command(['forward', `tcp:${port}`, `tcp:${port}`]);
    forwarded.push(port);
  }
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const viewer = await context.newPage();
    send('slide:0');
    await viewer.goto(connection.url);
    await expect(viewer.locator('#connection')).toHaveText('Синхронізовано', { timeout: 20_000 });
    await expect(viewer.locator('#preload')).toHaveText('Усі 3 слайдів завантажено', { timeout: 20_000 });
    send('slide:1');
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 2 / 3', { timeout: 20_000 });
    await viewer.locator('#viewer-previous').click();
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 1 / 3');
    await viewer.locator('#go-live').click();
    await expect(viewer.locator('#page-label')).toHaveText('Слайд 2 / 3');
    await viewer.screenshot({ path: path.join(root, `test-results/android-${name}-viewer.png`) });
    const fallback = await browser.newContext();
    const polling = await fallback.newPage();
    await polling.routeWebSocket('**/ws?**', (socket) => socket.close());
    await polling.goto(connection.url);
    await expect(polling.locator('#preload')).toHaveText('Усі 3 слайдів завантажено', { timeout: 20_000 });
    send('slide:2');
    await expect(polling.locator('#page-label')).toHaveText('Слайд 3 / 3', { timeout: 20_000 });
    await expect(polling.locator('#connection')).toHaveText('Резервний зв’язок', { timeout: 20_000 });
    await browser.close(); browser = null;
    console.log(`${name}: Android PDF preload, live sync, history and HTTP fallback passed.`);
  }
  send('stop');
  const code = await complete;
  if (code !== 0 || !output.includes('OK (1 test)')) throw new Error(`Android lifecycle harness failed:\n${output}`);
  console.log('Android foreground service and temporary-file cleanup passed.');
} finally {
  await browser?.close();
  if (!finished) {
    try { send('stop'); } catch {}
    await Promise.race([complete, pause(15_000)]);
    if (!finished) { try { command(['shell', 'am', 'force-stop', packageName]); } catch {} instrument.kill(); }
  }
  for (const port of forwarded) try { command(['forward', '--remove', `tcp:${port}`]); } catch {}
}
