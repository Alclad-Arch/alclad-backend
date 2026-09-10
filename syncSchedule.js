// When should the MYOB actuals sync run?
//
// THE SCHEDULER IS NOT THE GUARD. Whatever triggers a sync — an in-process timer, a Render cron
// job, someone at a terminal — the question "has this already run today?" has exactly one correct
// answer and it does not live in the scheduler's memory:
//
//   · a web service timer re-arms from zero on every restart and deploy, so a fixed-hour tick
//     drifts or double-fires;
//   · Render can run more than one instance of a web service, and each would hold its own timer,
//     so N instances mean N syncs and N Acumatica sessions — and sessions, not requests, are what
//     the licence counts. That is the failure that locks real people out of MYOB.
//
// So the answer is read from the DATA. Every sync stamps synced_at on every row it writes, which
// makes max(synced_at) the time of the last successful run — durable, shared between instances,
// and surviving any restart. A second trigger sees the fresh stamp and does nothing.
//
// This is deliberately NOT a cron expression. "Run when the data is older than N hours" is
// self-correcting in a way "run at 02:00" is not: a missed window is caught on the next tick
// rather than waited out for 24 hours, and a restart at 03:00 does not skip the day.

/* The gap that must have elapsed before another sync is worth doing.
 *
 * 20 hours, not 24: at exactly 24 a daily run drifts later every day by however long the previous
 * one took, and eventually skips a day entirely. 20 leaves room for the tick to land while still
 * being far enough from 24 that it cannot run twice in a working day. */
export const MIN_HOURS = 20;

/* How often to look. Hourly — the check itself is one small query, and an hour of staleness on a
   figure that changes daily is immaterial. */
export const CHECK_MS = 60 * 60 * 1000;

/* Should a sync run right now?
 *
 * `lastSyncedAt` is max(synced_at) from myob_actuals, or null when the table is empty. Returns a
 * reason either way, because "did not run" with no explanation is the state that gets mistaken for
 * a broken scheduler. */
export function shouldRunNow({ lastSyncedAt, now = Date.now(), minHours = MIN_HOURS } = {}) {
  if (!lastSyncedAt) {
    /* NEVER SYNCED. Run — an empty table means every linked project shows no cost, and waiting for
       a window helps nobody. */
    return { run: true, reason: 'never synced' };
  }
  const then = new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(then)) {
    /* An unparseable stamp is not a licence to sync repeatedly: treat it as recent and say so, so
       a bad value shows up as a stalled feed in the health panel rather than as a request loop
       against MYOB. */
    return { run: false, reason: `last sync time is unreadable (${lastSyncedAt})`, hours: null };
  }
  const hours = (now - then) / 3600000;
  if (hours < 0) {
    /* A stamp in the FUTURE — a clock skew, or someone's test data. Refuse rather than sync every
       tick until real time catches up. */
    return { run: false, reason: `last sync is in the future by ${Math.abs(hours).toFixed(1)}h`, hours };
  }
  if (hours < minHours) {
    return { run: false, reason: `synced ${hours.toFixed(1)}h ago, under the ${minHours}h minimum`, hours };
  }
  return { run: true, reason: `last synced ${hours.toFixed(1)}h ago`, hours };
}

/* A random delay before the first check, in ms.
 *
 * Two instances starting from the same deploy would otherwise tick in the same second, both read
 * the same stale stamp, and both sync — the exact double-session the guard exists to prevent. The
 * stamp is the real defence; this just makes the window that defeats it vanishingly narrow, by
 * spreading starts over the hour rather than aligning them.
 *
 * `rand` is injectable so the spread is testable rather than hoped for. */
export function startupJitterMs(rand = Math.random) {
  return Math.floor(rand() * CHECK_MS);
}

/* Is the scheduler switched on? OFF unless asked for, so deploying this cannot start making
   nightly requests against a live ERP by surprise — and so a Render Cron Job, which is the tidier
   arrangement, can be used instead without two things syncing. */
export function schedulerEnabled(env = process.env) {
  return String(env.MYOB_SYNC_SCHEDULE || '').trim() === '1';
}
