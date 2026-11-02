import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../desktop/before-pack.cjs', import.meta.url), 'utf8');
const Arch = { 0: 'ia32', 1: 'x64', 3: 'arm64' };

function hook(platform, arch, missingBinding = false) {
  const resolved = [];
  const module = { exports: {} };
  const require = (name) => {
    if (name === 'builder-util') return { Arch };
    assert.equal(name, '@napi-rs/canvas');
    return { createCanvas(width, height) { assert.deepEqual([width, height], [1, 1]); } };
  };
  require.resolve = (name) => {
    if (missingBinding) throw new Error('Missing native canvas');
    resolved.push(name);
  };
  runInNewContext(source, { module, require, process: { platform, arch } });
  return { build: module.exports, resolved };
}

test('desktop packaging requires matching native OS, architecture and canvas binding', async () => {
  for (const [platform, arch, target, binding] of [
    ['darwin', 'x64', 1, 'darwin-x64'],
    ['darwin', 'arm64', 3, 'darwin-arm64'],
    ['win32', 'x64', 1, 'win32-x64-msvc'],
  ]) {
    const { build, resolved } = hook(platform, arch);
    await build({ electronPlatformName: platform, arch: target });
    assert.deepEqual(resolved, [`@napi-rs/canvas-${binding}`]);
    await assert.rejects(hook(platform, arch, true).build({ electronPlatformName: platform, arch: target }), /Missing native canvas/);
  }
  for (const [platform, arch, targetPlatform, target] of [
    ['darwin', 'x64', 'win32', 1],
    ['win32', 'x64', 'darwin', 1],
    ['darwin', 'x64', 'darwin', 3],
    ['darwin', 'arm64', 'darwin', 1],
    ['win32', 'arm64', 'win32', 3],
    ['win32', 'x64', 'win32', 0],
    ['linux', 'x64', 'linux', 1],
  ]) {
    const { build, resolved } = hook(platform, arch);
    await assert.rejects(build({ electronPlatformName: targetPlatform, arch: target }), /matching OS and architecture/);
    assert.deepEqual(resolved, []);
  }
});
