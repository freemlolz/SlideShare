import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDesktopStore } from '../desktop/store.mjs';
import { isJoinUrl, isPresenterUrl, startDesktopServer } from '../desktop/runtime.mjs';

test('desktop polls survive port changes and reopening without storing session tokens', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'slidesync-store-test-'));
  try {
    const store = createDesktopStore(directory);
    assert.equal(store.port, 3000);
    assert.equal(store.readPolls(), '[]');
    const polls = [{ id: 'one', question: 'Питання?', options: ['Так', 'Ні'] }];
    store.writePolls(JSON.stringify(polls));
    store.setPort(45678);
    const reopened = createDesktopStore(directory);
    assert.equal(reopened.port, 45678);
    assert.deepEqual(JSON.parse(reopened.readPolls()), polls);
    const filename = path.join(directory, 'desktop-state.json');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(filename, 'utf8'))).sort(), ['polls', 'port', 'version']);
    assert.equal(statSync(filename).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('desktop store rejects malformed, oversized or excessive polls without replacing valid data', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'slidesync-store-test-'));
  try {
    const store = createDesktopStore(directory);
    store.setPort(3000);
    for (const value of ['invalid', '{}', JSON.stringify(Array(51).fill({})), ' '.repeat(256 * 1024 + 1),
      JSON.stringify([{ id: 'one', question: '', options: ['Yes', 'No'] }]),
      JSON.stringify([{ id: 'one', question: 'Question', options: ['Only one'] }])]) {
      assert.throws(() => store.writePolls(value));
      assert.equal(createDesktopStore(directory).readPolls(), '[]');
    }
    assert.throws(() => store.setPort(0));
    writeFileSync(path.join(directory, 'desktop-state.json'), 'broken');
    assert.throws(() => createDesktopStore(directory), /залишено без змін/);
    assert.equal(readFileSync(path.join(directory, 'desktop-state.json'), 'utf8'), 'broken');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('desktop server falls back only on a busy port and never stops the existing server', async () => {
  const calls = [];
  const result = await startDesktopServer(async ({ port }) => {
    calls.push(port);
    if (port === 3000) throw Object.assign(new Error('Busy'), { code: 'EADDRINUSE' });
    return { port: 43210 };
  }, 3000);
  assert.deepEqual(calls, [3000, 0]);
  assert.equal(result.port, 43210);
  await assert.rejects(startDesktopServer(async () => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); }, 3000), /Denied/);
});

test('desktop navigation allows only its presenter page; external opening only its exact viewer links', () => {
  const origin = 'http://127.0.0.1:45678';
  assert.ok(isPresenterUrl(`${origin}/host#token=secret`, origin));
  for (const value of ['https://example.com/host', `${origin}/join`, `${origin}/host?redirect=1`,
    'http://127.0.0.1:3000/host', `http://user@127.0.0.1:45678/host`, 'file:///tmp/host']) {
    assert.equal(isPresenterUrl(value, origin), false);
  }
  const session = { port: 45678, viewerToken: 'viewer', addresses: ['127.0.0.1', '192.168.1.2'] };
  assert.ok(isJoinUrl('http://192.168.1.2:45678/join#token=viewer', session));
  for (const value of ['https://example.com', 'file:///tmp/file', `${origin}/host#token=viewer`,
    `${origin}/join#token=host`, 'http://192.168.1.3:45678/join#token=viewer',
    'http://192.168.1.2:45678/join?extra=1#token=viewer']) assert.equal(isJoinUrl(value, session), false);
});
