import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AnnotationLayer } from '../src/annotations.mjs';
import { inkOpacity } from '../public/annotations.js';

function stroke(overrides = {}) {
  return { action: 'append', epoch: 0, id: 'stroke-1', tool: 'pencil', size: 6,
    color: '#ef4444', lifetime: 0, points: [[0.2, 0.3, 0.6]], finished: true, ...overrides };
}

test('streams a stroke, preserves pressure and finishes with selected lifetime', () => {
  const layer = new AnnotationLayer(() => {});
  try {
    layer.apply(stroke({ tool: 'brush', finished: false }));
    assert.equal(layer.snapshot().strokes[0].finished, false);
    layer.apply(stroke({ points: [[0.4, 0.5, 0.9]], finished: true }));
    const [saved] = layer.snapshot().strokes;
    assert.equal(saved.tool, 'brush');
    assert.equal(saved.expiresAt, null);
    assert.deepEqual(saved.points, [[0.2, 0.3, 0.6], [0.4, 0.5, 0.9]]);
    assert.throws(() => layer.apply(stroke()), (error) => error.status === 409);
  } finally { layer.close(); }
});

test('clear invalidates queued strokes even when presenter returns to the same slide', () => {
  const layer = new AnnotationLayer(() => {});
  try {
    layer.apply(stroke());
    layer.apply({ action: 'clear', epoch: 0 });
    assert.deepEqual(layer.snapshot(), { epoch: 1, strokes: [] });
    assert.throws(() => layer.apply(stroke({ id: 'late' })), (error) => error.status === 409);
    layer.reset();
    assert.throws(() => layer.apply(stroke({ epoch: 1, id: 'later' })), (error) => error.status === 409);
    layer.apply(stroke({ epoch: 2, id: 'new' }));
    assert.equal(layer.snapshot().strokes.length, 1);
  } finally { layer.close(); }
});

test('rejects invalid tools, sizes, lifetimes and normalized points without partial writes', () => {
  const layer = new AnnotationLayer(() => {});
  try {
    for (const override of [{ tool: 'html' }, { size: 0 }, { size: 33 }, { size: 1.5 },
      { color: 'red' }, { lifetime: 123 }, { points: [[-0.1, 0.2, 0.5]] },
      { points: [[0.2, 1.1, 0.5]] }, { points: [[0.2, 0.2, NaN]] },
      { points: [[0.2, 0.2]] }, { points: [] }, { points: Array(33).fill([0.1, 0.2, 0.5]) }]) {
      assert.throws(() => layer.apply(stroke(override)), (error) => error.status === 400);
      assert.equal(layer.snapshot().strokes.length, 0);
    }
  } finally { layer.close(); }
});

test('bounds stroke count and per-stroke point storage', () => {
  const layer = new AnnotationLayer(() => {});
  try {
    for (let index = 0; index < 64; index += 1) layer.apply(stroke({ id: `stroke-${index}` }));
    assert.throws(() => layer.apply(stroke({ id: 'over-limit' })), (error) => error.status === 413);
    layer.reset();
    for (let index = 0; index < 46; index += 1) {
      layer.apply(stroke({ epoch: 1, finished: false, points: Array(32).fill([0.2, 0.3, 0.4]) }));
    }
    assert.throws(() => layer.apply(stroke({ epoch: 1, points: Array(32).fill([0.2, 0.3, 0.4]) })), (error) => error.status === 413);
    assert.equal(layer.snapshot().strokes[0].points.length, 1472);
  } finally { layer.close(); }
});

test('temporary ink expires after five seconds while persistent ink remains', async () => {
  let changes = 0;
  const layer = new AnnotationLayer(() => { changes += 1; });
  try {
    layer.apply(stroke({ id: 'temporary', tool: 'marker', lifetime: 5000 }));
    layer.apply(stroke({ id: 'persistent' }));
    assert.equal(layer.snapshot().strokes.length, 2);
    await delay(5200);
    assert.deepEqual(layer.snapshot().strokes.map((entry) => entry.id), ['persistent']);
    assert.equal(changes, 1);
  } finally { layer.close(); }
});

test('temporary ink smoothly fades during its last second without extending its lifetime', () => {
  const ink = { ...stroke({ lifetime: 5000 }), expiresAt: 10_000 };
  assert.equal(inkOpacity(ink, 8500), 1);
  assert.equal(inkOpacity(ink, 9000), 1);
  assert.equal(inkOpacity(ink, 9500), 0.5);
  assert.equal(inkOpacity(ink, 9750), 0.15625);
  assert.equal(inkOpacity(ink, 10_000), 0);
  assert.equal(inkOpacity(ink, 11_000), 0);
  assert.equal(inkOpacity({ ...ink, finished: false }, 9750), 1);
  assert.equal(inkOpacity({ ...ink, lifetime: 0, expiresAt: null }, 11_000), 1);
});

test('manual clear fades from current opacity instead of flashing back to full strength', () => {
  const ink = { ...stroke(), expiresAt: null, fadeStartedAt: 1000, fadeEndsAt: 1250, fadeFromOpacity: 0.6 };
  assert.equal(inkOpacity(ink, 1000), 0.6);
  assert.equal(inkOpacity(ink, 1125), 0.3);
  assert.equal(inkOpacity(ink, 1250), 0);
  assert.equal(inkOpacity(ink, 1500), 0);
});
