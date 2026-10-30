import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PollSession, POLL_DURATION_MS } from '../src/polls.mjs';

function createSession(context, onChange = () => {}) {
  let now = 1000;
  const session = new PollSession(onChange, { now: () => now });
  context.after(() => session.close());
  return { session, advance: (duration) => { now += duration; } };
}

function question(overrides = {}) {
  return { question: ' Який варіант обираєте? ', options: [' Так ', ' Ні '], ...overrides };
}

function hasStatus(status) {
  return (error) => error instanceof Error && error.status === status;
}

test('opens a ten-second poll with trimmed copies and no early tallies', (context) => {
  let changes = 0;
  const { session } = createSession(context, () => { changes += 1; });
  assert.equal(POLL_DURATION_MS, 10000);
  assert.equal(session.snapshot(), null);
  const input = question();
  session.start(input);
  const snapshot = session.snapshot('viewer');
  assert.equal(typeof snapshot.id, 'string');
  assert.ok(snapshot.id.length > 0);
  assert.deepEqual(snapshot, { id: snapshot.id, question: 'Який варіант обираєте?',
    options: ['Так', 'Ні'], status: 'open', startsAt: 1000, endsAt: 11000,
    total: 0, vote: null, counts: null });
  input.question = 'Changed';
  input.options[0] = 'Changed';
  input.options.push('Extra');
  snapshot.question = 'Changed snapshot';
  snapshot.options[0] = 'Changed snapshot';
  session.vote({ pollId: snapshot.id, answer: 0 }, 'viewer');
  assert.equal(session.snapshot('viewer').question, 'Який варіант обираєте?');
  assert.deepEqual(session.snapshot('viewer').options, ['Так', 'Ні']);
  assert.equal(session.snapshot('viewer').vote, 0);
  assert.equal(session.snapshot('other').vote, null);
  assert.equal(session.snapshot().total, 1);
  assert.equal(session.snapshot().counts, null);
  assert.equal(changes, 0);
});

test('accepts exactly two or four answers and inclusive trimmed length limits', (context) => {
  const { session } = createSession(context);
  for (const options of [['A', 'B'], ['A', 'B', 'C', 'D'],
    [` ${'A'.repeat(100)} `, ' B ']]) {
    session.start(question({ question: ` ${'Q'.repeat(200)} `, options }));
    assert.equal(session.snapshot().question.length, 200);
    assert.deepEqual(session.snapshot().options, options.map((option) => option.trim()));
    const pollId = session.snapshot().id;
    session.vote({ pollId, answer: options.length - 1 }, 'viewer');
    assert.equal(session.snapshot('viewer').vote, options.length - 1);
    session.cancel(pollId);
  }
  session.start(question({ question: ' Q ', options: [' A ', ' B '] }));
  assert.equal(session.snapshot().question, 'Q');
});

test('rejects malformed questions and answers without creating a poll', (context) => {
  const { session } = createSession(context);
  for (const input of [undefined, null, false, 42, 'question', {},
    ...[undefined, null, 1, {}, '', ' \n ', 'Q'.repeat(201)].map((value) => question({ question: value })),
    ...[undefined, null, 'A,B', {}, [], ['A'], ['A', 'B', 'C'], ['A', 'B', 'C', 'D', 'E'],
      ['A', null], ['A', 1], ['A', {}], ['A', ''], ['A', ' \n '], ['A', 'B'.repeat(101)],
      [' A ', 'a'], ['Так', 'ТАК'], ['A', 'B', 'C', ' c '], Array(2), ['A', , 'B', 'C']]
      .map((options) => question({ options }))]) {
    assert.throws(() => session.start(input), hasStatus(400));
    assert.equal(session.snapshot(), null);
  }
});

test('rejects a second start while open without changing the current poll', (context) => {
  const { session } = createSession(context);
  session.start(question());
  const before = session.snapshot();
  assert.throws(() => session.start(question()), hasStatus(409));
  assert.deepEqual(session.snapshot(), before);
});

test('makes identical votes idempotent and prevents changing an answer', (context) => {
  let changes = 0;
  const { session, advance } = createSession(context, () => { changes += 1; });
  session.start(question());
  const pollId = session.snapshot().id;
  session.vote({ pollId, answer: 0 }, 'first');
  session.vote({ pollId, answer: 0 }, 'first');
  assert.throws(() => session.vote({ pollId, answer: 1 }, 'first'), hasStatus(409));
  session.vote({ pollId, answer: 1 }, 'second');
  assert.equal(session.snapshot().total, 2);
  assert.equal(session.snapshot().counts, null);
  assert.equal(changes, 0);
  advance(POLL_DURATION_MS);
  assert.deepEqual(session.snapshot('first').counts, [1, 1]);
  assert.equal(session.snapshot('first').vote, 0);
  assert.equal(changes, 1);
});

test('rejects invalid votes, identities, and stale ids without recording votes', (context) => {
  const { session } = createSession(context);
  assert.throws(() => session.vote(null, 'viewer'), hasStatus(409));
  session.start(question());
  const pollId = session.snapshot().id;
  for (const message of [null, undefined, {}, { pollId: 'stale', answer: 0 }]) {
    assert.throws(() => session.vote(message, 'viewer'), hasStatus(409));
  }
  for (const answer of [undefined, null, '0', false, -1, 2, 0.5, NaN, Infinity]) {
    assert.throws(() => session.vote({ pollId, answer }, 'viewer'), hasStatus(400));
  }
  for (const voterId of [undefined, null, '', ' \n ', 0, false, {}, []]) {
    assert.throws(() => session.vote({ pollId, answer: 0 }, voterId), hasStatus(400));
  }
  assert.equal(session.snapshot().total, 0);
});

test('accepts votes before ten seconds and rejects them exactly at the deadline', (context) => {
  let changes = 0;
  let session;
  const clock = createSession(context, () => {
    changes += 1;
    assert.equal(session.snapshot().status, 'results');
  });
  session = clock.session;
  session.start(question());
  const pollId = session.snapshot().id;
  clock.advance(9999);
  session.vote({ pollId, answer: 1 }, 'last');
  assert.equal(session.snapshot().status, 'open');
  assert.equal(session.snapshot().counts, null);
  clock.advance(1);
  assert.throws(() => session.vote({ pollId, answer: 0 }, 'late'), hasStatus(409));
  assert.throws(() => session.vote({ pollId, answer: 1 }, 'last'), hasStatus(409));
  assert.equal(session.snapshot().total, 1);
  assert.deepEqual(session.snapshot().counts, [0, 1]);
  clock.advance(1000);
  assert.throws(() => session.vote({ pollId, answer: 0 }, 'later'), hasStatus(409));
  assert.equal(changes, 1);
});

test('snapshots settle delayed deadlines once and keep result copies independent', (context) => {
  let changes = 0;
  const { session, advance } = createSession(context, () => { changes += 1; });
  session.start(question({ options: ['A', 'B', 'C', 'D'] }));
  const pollId = session.snapshot().id;
  session.vote({ pollId, answer: 3 }, 'viewer');
  advance(POLL_DURATION_MS + 1000);
  const results = session.snapshot('viewer');
  assert.equal(results.status, 'results');
  assert.equal(results.total, 1);
  assert.equal(results.vote, 3);
  assert.deepEqual(results.counts, [0, 0, 0, 1]);
  results.counts[3] = 99;
  results.options[3] = 'Changed';
  assert.deepEqual(session.snapshot().counts, [0, 0, 0, 1]);
  assert.deepEqual(session.snapshot().options, ['A', 'B', 'C', 'D']);
  assert.equal(changes, 1);
});

test('completed polls can be rerun with fresh ids and stale votes are rejected', (context) => {
  const { session, advance } = createSession(context);
  session.start(question());
  const firstId = session.snapshot().id;
  session.vote({ pollId: firstId, answer: 0 }, 'viewer');
  advance(POLL_DURATION_MS);
  const results = session.snapshot();
  assert.throws(() => session.start(null), hasStatus(400));
  assert.deepEqual(session.snapshot(), results);
  session.start(question());
  const next = session.snapshot('viewer');
  assert.notEqual(next.id, firstId);
  assert.equal(next.startsAt, results.endsAt);
  assert.equal(next.endsAt, next.startsAt + POLL_DURATION_MS);
  assert.equal(next.status, 'open');
  assert.equal(next.total, 0);
  assert.equal(next.vote, null);
  assert.equal(next.counts, null);
  assert.throws(() => session.vote({ pollId: firstId, answer: 0 }, 'viewer'), hasStatus(409));
  session.vote({ pollId: next.id, answer: 1 }, 'viewer');
  assert.equal(session.snapshot('viewer').vote, 1);
});

test('starting after a delayed deadline settles the old poll before opening the next', (context) => {
  let changes = 0;
  const { session, advance } = createSession(context, () => { changes += 1; });
  session.start(question());
  const firstId = session.snapshot().id;
  advance(POLL_DURATION_MS);
  session.start(question());
  assert.notEqual(session.snapshot().id, firstId);
  assert.equal(session.snapshot().status, 'open');
  assert.equal(changes, 1);
});

test('cancel requires the current id and silently clears open polls and results', (context) => {
  let changes = 0;
  const { session, advance } = createSession(context, () => { changes += 1; });
  assert.throws(() => session.cancel(null), hasStatus(409));
  session.start(question());
  const pollId = session.snapshot().id;
  for (const id of [null, undefined, 'stale']) {
    assert.throws(() => session.cancel(id), hasStatus(409));
    assert.equal(session.snapshot().id, pollId);
  }
  session.cancel(pollId);
  advance(POLL_DURATION_MS);
  assert.equal(session.snapshot(), null);
  assert.throws(() => session.vote({ pollId, answer: 0 }, 'viewer'), hasStatus(409));
  assert.equal(changes, 0);
  session.start(question());
  const nextId = session.snapshot().id;
  assert.notEqual(nextId, pollId);
  assert.throws(() => session.cancel(pollId), hasStatus(409));
  advance(POLL_DURATION_MS);
  assert.equal(session.snapshot().status, 'results');
  session.cancel(nextId);
  assert.equal(session.snapshot(), null);
  assert.equal(changes, 1);
});

test('bounds votes at 10000 while preserving idempotent retries and immutable choices', (context) => {
  const { session, advance } = createSession(context);
  session.start(question());
  const pollId = session.snapshot().id;
  for (let index = 0; index < 10000; index += 1) {
    session.vote({ pollId, answer: index % 2 }, `viewer-${index}`);
  }
  assert.equal(session.snapshot().total, 10000);
  session.vote({ pollId, answer: 0 }, 'viewer-0');
  assert.throws(() => session.vote({ pollId, answer: 1 }, 'viewer-0'), hasStatus(409));
  assert.throws(() => session.vote({ pollId, answer: 0 }, 'overflow'), hasStatus(413));
  assert.equal(session.snapshot('overflow').vote, null);
  advance(POLL_DURATION_MS);
  assert.deepEqual(session.snapshot().counts, [5000, 5000]);
});

test('timer alone reveals zero-vote results exactly once and supports reentrant snapshots', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let changes = 0;
  const session = new PollSession(() => {
    changes += 1;
    assert.equal(session.snapshot().status, 'results');
  });
  context.after(() => session.close());
  session.start(question());
  context.mock.timers.tick(9999);
  assert.equal(changes, 0);
  assert.equal(session.snapshot().status, 'open');
  context.mock.timers.tick(1);
  assert.equal(changes, 1);
  assert.deepEqual(session.snapshot().counts, [0, 0]);
  assert.equal(session.snapshot().total, 0);
  assert.equal(session.snapshot().vote, null);
  context.mock.timers.tick(POLL_DURATION_MS);
  assert.equal(changes, 1);
});

test('cancelled and closed timers never notify, including after starting a replacement', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let changes = 0;
  const session = new PollSession(() => { changes += 1; });
  context.after(() => session.close());
  session.start(question());
  const firstId = session.snapshot().id;
  context.mock.timers.tick(5000);
  session.cancel(firstId);
  session.start(question());
  context.mock.timers.tick(5000);
  assert.equal(changes, 0);
  assert.equal(session.snapshot().status, 'open');
  session.close();
  session.close();
  context.mock.timers.tick(POLL_DURATION_MS);
  assert.equal(changes, 0);
});

test('an early timer wakeup reschedules until the injected clock reaches the deadline', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let changes = 0;
  const { session, advance } = createSession(context, () => { changes += 1; });
  session.start(question());
  context.mock.timers.tick(POLL_DURATION_MS);
  assert.equal(changes, 0);
  assert.equal(session.snapshot().status, 'open');
  advance(POLL_DURATION_MS);
  context.mock.timers.tick(POLL_DURATION_MS);
  assert.equal(changes, 1);
  assert.equal(session.snapshot().status, 'results');
});
