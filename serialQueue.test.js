// One refresh at a time. Run with: npm test
//
// This exists because of a live outage, not a hypothetical. The Salesforce service grant died on
// 2026-09-14 after five healthy rotations, and the cause was two refreshes running at once:
// Salesforce invalidates a refresh token when it is used, so the second refresh killed the first
// one's token, and whichever store finished last wrote a token Salesforce had already discarded.
// Nothing logged an error — every individual step succeeded.
//
// The property that matters is OVERLAP, so that is what these assert: not that the right number of
// calls happened, but that no two were ever in flight together.
import assert from "node:assert/strict";
import test from "node:test";
import { serialQueue } from "./serialQueue.js";

/* A task that records when it starts and ends, so overlap is observable rather than inferred. */
function tracker() {
  const log = [];
  let live = 0, maxLive = 0;
  const task = (name, { ms = 5, fail = false, value } = {}) => async () => {
    live += 1; maxLive = Math.max(maxLive, live);
    log.push('start:' + name);
    await new Promise((r) => setTimeout(r, ms));
    log.push('end:' + name);
    live -= 1;
    if (fail) throw new Error(name + ' failed');
    return value === undefined ? name : value;
  };
  return { task, log, peak: () => maxLive };
}

test("two tasks queued at once never overlap", async () => {
  const t = tracker();
  const q = serialQueue();
  await Promise.all([q(t.task('a')), q(t.task('b'))]);
  assert.equal(t.peak(), 1, 'two refreshes were in flight together — this is the outage');
  assert.deepEqual(t.log, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test("a burst of ten stays strictly one at a time", async () => {
  /* The real shape: a free Render instance wakes and the hub fires several requests at once, all
     missing an empty cache. */
  const t = tracker();
  const q = serialQueue();
  await Promise.all(Array.from({ length: 10 }, (_, i) => q(t.task('t' + i, { ms: 1 }))));
  assert.equal(t.peak(), 1);
});

test("tasks run in the order they were queued", async () => {
  const t = tracker();
  const q = serialQueue();
  // Descending durations: without ordering, the shortest would finish first.
  await Promise.all([q(t.task('a', { ms: 15 })), q(t.task('b', { ms: 8 })), q(t.task('c', { ms: 1 }))]);
  assert.deepEqual(t.log.filter((l) => l.startsWith('start')), ['start:a', 'start:b', 'start:c']);
});

test("each caller gets its OWN result, not a shared one", async () => {
  /* A queue, not a shared in-flight promise — and this is the difference. A caller that asks
     BECAUSE the last token 401'd must not be handed that same token back. */
  const q = serialQueue();
  const [a, b] = await Promise.all([q(async () => 'first'), q(async () => 'second')]);
  assert.equal(a, 'first');
  assert.equal(b, 'second');
});

test("a failure rejects ONLY its own caller", async () => {
  const q = serialQueue();
  const bad = q(async () => { throw new Error('boom'); });
  const good = q(async () => 'fine');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'fine');
});

test("⚠ a failure does not poison the queue", async () => {
  /* The trap in the obvious implementation: assign the rejected promise as the tail and every
     later task inherits the rejection, so one failed refresh takes Salesforce down until restart. */
  const q = serialQueue();
  await assert.rejects(q(async () => { throw new Error('first'); }), /first/);
  assert.equal(await q(async () => 'still works'), 'still works');
  await assert.rejects(q(async () => { throw new Error('second'); }), /second/);
  assert.equal(await q(async () => 'and again'), 'and again');
});

test("…and a failing task still does not overlap the next", async () => {
  const t = tracker();
  const q = serialQueue();
  const results = await Promise.allSettled([q(t.task('a', { fail: true })), q(t.task('b'))]);
  assert.equal(t.peak(), 1);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
});

test("a synchronous throw is caught like any other failure", async () => {
  // fn is called inside .then, so a sync throw becomes a rejection rather than escaping.
  const q = serialQueue();
  await assert.rejects(q(() => { throw new Error('sync'); }), /sync/);
  assert.equal(await q(async () => 'ok'), 'ok');
});

test("two queues are independent", async () => {
  const t = tracker();
  const q1 = serialQueue(), q2 = serialQueue();
  await Promise.all([q1(t.task('a')), q2(t.task('b'))]);
  assert.equal(t.peak(), 2, 'separate queues must not serialise against each other');
});

test("a queue left idle still runs the next task", async () => {
  const q = serialQueue();
  assert.equal(await q(async () => 1), 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await q(async () => 2), 2);
});
