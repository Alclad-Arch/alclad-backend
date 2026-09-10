// When the actuals sync should run.
//
// Two things are being defended here.
//
// FIRST, the DATA decides, not the scheduler's memory — a timer in a web service re-arms on every
// restart and exists once per instance, and N instances syncing means N Acumatica sessions.
// Sessions are what the licence counts, so a double-run is not a wasted request, it is a step
// towards locking real people out of MYOB.
//
// SECOND, the run time must not DRIFT. "Sync when older than 20h", checked hourly, lands 20–21h
// after the last run, so it walks 3–4h earlier each day and cycles through the clock. Adding a
// preferred window on top did not fix that — from a start outside the window the valve fires before
// any window is reached, and traced against the live data it ran at 26h every time. Anchoring to
// the window's OPENING is what makes it stable, and the drift test near the bottom is the one that
// would have caught both wrong versions.
import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldRunNow, startupJitterMs, schedulerEnabled, inWindow, windowStart,
  MIN_HOURS, CHECK_MS, MAX_HOURS, WINDOW_UTC, FIRST_CHECK_MS,
} from "./syncSchedule.js";

const at = (utcHour, day = 11) =>
  Date.parse(`2026-09-${String(day).padStart(2, "0")}T${String(utcHour).padStart(2, "0")}:30:00Z`);
/* 16:30 UTC — inside the window, so tests about something else are not silently decided by it. */
const NOW = at(16);
/* Hours before a GIVEN now. A single anchored helper once made three tests measure 11 hours while
   claiming 21, so the `now` is always passed in. */
const before = (h, now = NOW) => new Date(now - h * 3600000).toISOString();

// ── the empty and the broken ──────────────────────────────────────────────
test("an empty table syncs, whatever the hour", () => {
  /* No rows means every linked project in the hub shows no actual cost, and waiting until 1am for
     that is indefensible. */
  for (const h of [3, 9, 16, 22]) {
    assert.equal(shouldRunNow({ lastSyncedAt: null, now: at(h) }).run, true, `refused at ${h}:00Z`);
  }
});

test("a stamp in the FUTURE refuses, rather than syncing every tick", () => {
  const r = shouldRunNow({ lastSyncedAt: before(-3), now: NOW });
  assert.equal(r.run, false);
  assert.match(r.reason, /in the future/);
});

test("an unreadable stamp refuses too, and says so", () => {
  /* Treating it as "never synced" would sync on every tick against a live ERP. */
  const r = shouldRunNow({ lastSyncedAt: "not a date", now: NOW });
  assert.equal(r.run, false);
  assert.match(r.reason, /unreadable/);
});

test("every answer carries a reason", () => {
  /* "Did not run" with no explanation is what gets mistaken for a broken scheduler. */
  for (const last of [null, before(1), before(21), before(30), "rubbish", before(-1)]) {
    const r = shouldRunNow({ lastSyncedAt: last, now: NOW });
    assert.ok(r.reason && r.reason.length > 5, `no reason for ${last}`);
  }
});

// ── the window ────────────────────────────────────────────────────────────
test("the window is overnight in Melbourne in BOTH AEST and AEDT", () => {
  /* 15–20 UTC is 01:00–06:00 at +10 and 02:00–07:00 at +11, so the daylight-saving changeover needs
     no attention — which is the whole reason for choosing it. */
  assert.deepEqual(WINDOW_UTC, [15, 20]);
  assert.equal(inWindow(at(15)), true);
  assert.equal(inWindow(at(19)), true);
  assert.equal(inWindow(at(20)), false, "the end is exclusive");
  assert.equal(inWindow(at(14)), false);
  assert.equal(inWindow(at(3)), false, "03:00 UTC is lunchtime in Melbourne");
});

test("a window that wraps midnight still works", () => {
  /* The day someone moves it to 22–04 is not the day to discover the comparison only handled
     from < to. */
  assert.equal(inWindow(at(23), [22, 4]), true);
  assert.equal(inWindow(at(2), [22, 4]), true);
  assert.equal(inWindow(at(12), [22, 4]), false);
});

test("windowStart is today's opening — and YESTERDAY's for a wrapping window", () => {
  assert.equal(windowStart(at(16)), Date.parse("2026-09-11T15:00:00Z"));
  /* 02:30 with a 22–04 window belongs to the window that opened last night. Getting this wrong
     compares against an opening in the future and refuses for ever. */
  assert.equal(windowStart(at(2), [22, 4]), Date.parse("2026-09-10T22:00:00Z"));
  assert.equal(windowStart(at(23), [22, 4]), Date.parse("2026-09-11T22:00:00Z"));
});

test("in the window, not having synced since it opened — runs", () => {
  const r = shouldRunNow({ lastSyncedAt: before(20, at(16)), now: at(16) });
  assert.equal(r.run, true);
  assert.match(r.reason, /in the 15:00–20:00 UTC window/);
});

test("a second tick inside the same window does not sync again", () => {
  /* THE FLOOR catches this, not the window check: the window is 5h wide and the floor is 12h, so
     two runs in one window are impossible before the floor refuses. Asserted on the real wording
     rather than the one I assumed. */
  const r = shouldRunNow({ lastSyncedAt: "2026-09-11T15:10:00Z", now: at(19) });
  assert.equal(r.run, false);
  assert.match(r.reason, /under the 12h floor/);
});

test("the once-per-window check earns its place only if the window is widened", () => {
  /* With WINDOW_UTC only 5h wide and a 12h floor, the `then >= windowStart` comparison can never
     decide anything — the floor always gets there first, so that branch is unreachable in the
     shipped configuration. It is kept because it becomes load-bearing the moment someone widens
     the window past the floor, and this test is what proves it still works when that happens
     rather than having quietly rotted as dead code nobody exercises. */
  const wide = [6, 23];
  const r = shouldRunNow({
    lastSyncedAt: "2026-09-11T07:00:00Z", now: at(20), windowUtc: wide,
  });
  assert.equal(r.run, false);
  assert.match(r.reason, /already synced in this 6:00–23:00 UTC window/);
  /* And a sync from BEFORE that window opened still runs. */
  assert.equal(shouldRunNow({
    lastSyncedAt: "2026-09-10T20:00:00Z", now: at(20), windowUtc: wide,
  }).run, true);
});

test("outside the window and not yet stale — waits, and says what for", () => {
  const r = shouldRunNow({ lastSyncedAt: before(21, at(9)), now: at(9) });
  assert.equal(r.run, false);
  assert.match(r.reason, /waiting for the 15:00–20:00 UTC window/);
  assert.match(r.reason, /syncs anyway past 26h/);
});

// ── the valve ─────────────────────────────────────────────────────────────
test("past the valve it runs regardless of the hour", () => {
  /* A window that can starve is a bug: a service asleep or restarting through every window would
     never sync, and the hub would show last week's cost with nothing saying so. */
  assert.equal(MAX_HOURS, 26);
  const r = shouldRunNow({ lastSyncedAt: before(27, at(6)), now: at(6) });
  assert.equal(r.run, true);
  assert.match(r.reason, /past 26h/);
});

test("no hour of the day can deadlock it", () => {
  for (let h = 0; h < 24; h++) {
    assert.equal(shouldRunNow({ lastSyncedAt: before(MAX_HOURS + 1, at(h)), now: at(h) }).run, true,
      `stuck at ${h}:00 UTC`);
  }
});

// ── the floor ─────────────────────────────────────────────────────────────
test("the floor sits BELOW the shortest window-to-window gap", () => {
  /* That gap is 19h: a run at 19:59 UTC is 19h01m before the next opening at 15:00. A floor of 20
     would veto exactly the run the window is asking for and hand control back to the valve — which
     is how the drift crept back into the second version. */
  assert.ok(MIN_HOURS < 19, `${MIN_HOURS} must be under 19`);
  const r = shouldRunNow({ lastSyncedAt: "2026-09-10T19:59:00Z", now: at(15) });
  assert.equal(r.run, true, "the tightest legitimate gap must still be allowed");
});

test("the floor stops a quick second sync", () => {
  const r = shouldRunNow({ lastSyncedAt: before(2, at(16)), now: at(16) });
  assert.equal(r.run, false);
  assert.match(r.reason, /under the 12h floor/);
});

// ── THE DRIFT TEST ────────────────────────────────────────────────────────
test("simulated over a fortnight it syncs ONCE A DAY, always in the window", () => {
  /* The test that would have caught both earlier versions. Ticks hourly for 14 days from a start
     deliberately OUTSIDE the window — the real situation, since the last prod sync was 06:04 UTC —
     and checks the run times settle rather than walking round the clock. */
  let last = "2026-09-10T06:04:54.484Z";        // the actual last prod sync
  const start = Date.parse(last);
  const runs = [];
  for (let t = start + 3600000; t < start + 14 * 24 * 3600000; t += 3600000) {
    const r = shouldRunNow({ lastSyncedAt: last, now: t });
    if (r.run) { runs.push(new Date(t)); last = new Date(t).toISOString(); }
  }
  /* One a day, give or take where the first lands. */
  assert.ok(runs.length >= 13 && runs.length <= 14, `${runs.length} runs in 14 days`);

  /* NO DRIFT. After the first — which the valve fires, because the start is mid-afternoon UTC —
     every run must be inside the window. The earlier versions marched 2–4h earlier each day. */
  const settled = runs.slice(1);
  const outside = settled.filter((d) => !inWindow(d.getTime()));
  assert.equal(outside.length, 0,
    `${outside.length} outside the window: ${outside.map((d) => d.toISOString()).join(", ")}`);

  /* And never twice in a day. */
  const days = settled.map((d) => d.toISOString().slice(0, 10));
  assert.equal(new Set(days).size, days.length, `two runs in one day: ${days.join(", ")}`);
});

// ── jitter and the switch ─────────────────────────────────────────────────
test("the first check happens within a MINUTE, not an hour", () => {
  /* ⚠ THE ONE THAT MADE THE SCHEDULE UNABLE TO FIRE. Render's free tier spins the service down after
     about fifteen minutes idle, and with up to an hour of jitter the log read "first check in 37
     min" — a check that never arrives, re-armed identically on every wake. On is not the same as
     running, and the startup line said ON. */
  assert.equal(FIRST_CHECK_MS, 60 * 1000);
  assert.ok(FIRST_CHECK_MS < 15 * 60 * 1000, 'must land before a free instance sleeps');
  assert.equal(startupJitterMs(() => 0), 0);
  assert.equal(startupJitterMs(() => 0.5), FIRST_CHECK_MS / 2);
  /* Strictly inside, so it cannot equal the bound and slip past. */
  assert.ok(startupJitterMs(() => 0.999999) < FIRST_CHECK_MS);
});

test("the hourly interval is still an hour — only the FIRST check moved", () => {
  /* Shortening the interval too would hammer the database on a service that never sleeps. */
  assert.equal(CHECK_MS, 60 * 60 * 1000);
});

test("the scheduler is OFF unless explicitly enabled", () => {
  assert.equal(schedulerEnabled({}), false);
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: "" }), false);
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: "0" }), false);
  /* Not "truthy" — "false" and "no" are things people type expecting them to mean off. */
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: "false" }), false);
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: "no" }), false);
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: "1" }), true);
  assert.equal(schedulerEnabled({ MYOB_SYNC_SCHEDULE: " 1 " }), true, "a pasted value often carries spaces");
});
