// When the actuals sync should run.
//
// The whole point of this module is that the DATA decides, not the scheduler's memory — because a
// timer in a web service re-arms on every restart and exists once per instance, and N instances
// syncing means N Acumatica sessions. Sessions are what the licence counts, so a double-run is not
// a wasted request, it is a step towards locking real people out of MYOB.
//
// So these tests are mostly about when it must NOT run.
import assert from "node:assert/strict";
import test from "node:test";
import { shouldRunNow, startupJitterMs, schedulerEnabled, MIN_HOURS, CHECK_MS } from "./syncSchedule.js";

const NOW = Date.parse("2026-09-11T02:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test("an empty table syncs — waiting for a window helps nobody", () => {
  /* No rows means every linked project in the hub shows no actual cost. */
  const r = shouldRunNow({ lastSyncedAt: null, now: NOW });
  assert.equal(r.run, true);
  assert.match(r.reason, /never synced/);
});

test("a day-old sync runs again", () => {
  const r = shouldRunNow({ lastSyncedAt: hoursAgo(24), now: NOW });
  assert.equal(r.run, true);
  assert.match(r.reason, /24\.0h ago/);
});

test("a sync an hour ago does NOT run again", () => {
  /* This is the guard doing its job: a second instance's timer, a redeploy, or someone running it
     by hand must not open another session. */
  const r = shouldRunNow({ lastSyncedAt: hoursAgo(1), now: NOW });
  assert.equal(r.run, false);
  assert.match(r.reason, /1\.0h ago, under the 20h minimum/);
});

test("the threshold is 20 hours, not 24", () => {
  /* At exactly 24 a daily run drifts later by however long the previous one took, and eventually
     skips a day. 20 leaves room to land while staying far from twice in a working day. */
  assert.equal(MIN_HOURS, 20);
  assert.equal(shouldRunNow({ lastSyncedAt: hoursAgo(19.9), now: NOW }).run, false);
  assert.equal(shouldRunNow({ lastSyncedAt: hoursAgo(20.1), now: NOW }).run, true);
});

test("a stamp in the FUTURE refuses, rather than syncing every tick", () => {
  /* Clock skew or someone's test row. Running on every check until real time catches up would be a
     request loop against a live ERP. */
  const r = shouldRunNow({ lastSyncedAt: hoursAgo(-3), now: NOW });
  assert.equal(r.run, false);
  assert.match(r.reason, /in the future/);
});

test("an unreadable stamp refuses too, and says so", () => {
  /* Treating it as "never synced" would sync on every tick. Refusing makes it surface as a stalled
     feed in the health panel — visible, and not a loop. */
  const r = shouldRunNow({ lastSyncedAt: "not a date", now: NOW });
  assert.equal(r.run, false);
  assert.match(r.reason, /unreadable/);
});

test("every answer carries a reason", () => {
  /* "Did not run" with no explanation is what gets mistaken for a broken scheduler. */
  for (const last of [null, hoursAgo(1), hoursAgo(30), "rubbish", hoursAgo(-1)]) {
    const r = shouldRunNow({ lastSyncedAt: last, now: NOW });
    assert.ok(r.reason && r.reason.length > 5, `no reason for ${last}`);
  }
});

// ── startup jitter ────────────────────────────────────────────────────────
test("jitter spreads the first check across the hour", () => {
  assert.equal(startupJitterMs(() => 0), 0);
  assert.equal(startupJitterMs(() => 0.5), CHECK_MS / 2);
  /* Strictly inside the window — a jitter that can equal the interval delays the first check by a
     whole extra hour. */
  assert.ok(startupJitterMs(() => 0.999999) < CHECK_MS);
});

// ── the switch ────────────────────────────────────────────────────────────
test("the scheduler is OFF unless explicitly enabled", () => {
  /* Deploying this must not start making nightly requests against a live ERP by surprise, and a
     Render Cron Job — the tidier arrangement — must be usable without two things syncing. */
  assert.equal(schedulerEnabled({}), false);
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: '' }), false);
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: '0' }), false);
  /* Not "truthy" — "false" and "no" are things people type expecting them to mean off. */
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: 'false' }), false);
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: 'no' }), false);
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: '1' }), true);
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: ' 1 ' }), true, 'a pasted value often carries spaces');
});
