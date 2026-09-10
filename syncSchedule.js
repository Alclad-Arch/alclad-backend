// When should the MYOB actuals sync run?
//
// THE SCHEDULER IS NOT THE GUARD. Whatever triggers a sync — an in-process timer, a Render cron
// job, someone at a terminal — the question "has this already run today?" has exactly one correct
// answer and it does not live in the scheduler's memory:
//
//   · a web service timer re-arms from zero on every restart and deploy;
//   · Render can run more than one instance of a web service, each holding its own timer, so N
//     instances mean N syncs and N Acumatica sessions — and sessions, not requests, are what the
//     licence counts. That is the failure that locks real people out of MYOB.
//
// So the answer is read from the DATA. Every sync stamps synced_at on every row it writes, which
// makes max(synced_at) the time of the last successful run — durable, shared between instances,
// and surviving any restart.
//
// THE RULE IS "ONCE PER WINDOW", plus a staleness valve:
//
//   run if   we are inside the nightly window AND nothing has synced since it opened
//   or if    the data is older than MAX_HOURS, whatever the time
//
// An earlier version said "run when older than 20 hours", checked hourly. That drifts: each run
// lands 20–21h after the last, so it walks 3–4h earlier each day and cycles through the clock —
// 4am one day, 3pm the next. Adding a preferred window on top did not fix it, because from a start
// outside the window the 26h valve fires before any window is reached; traced against the live
// data it ran at 26h every time and the window achieved nothing. Anchoring to the WINDOW rather
// than to the last run is what makes it stable, and it is self-correcting in the way a cron is not:
// a missed window is caught by the valve rather than waited out for another day.

/* The nightly window, in UTC hours — Render runs in UTC.
 *
 * 15:00–20:00 UTC is 01:00–06:00 in Melbourne at AEST (+10) and 02:00–07:00 at AEDT (+11), so this
 * needs no attention at the daylight-saving changeover. Five hours wide because the checks are
 * hourly and a service that restarts, or sleeps briefly, should still find the window open. */
export const WINDOW_UTC = [15, 20];

/* How often to look. Hourly — the check is one small query, and the window is wide enough that an
   hourly cadence cannot miss it. */
export const CHECK_MS = 60 * 60 * 1000;

/* The staleness valve: past this, sync whatever the hour.
 *
 * Without it the window could starve — a service asleep or restarting through every window would
 * never sync, and the hub would show last week's cost with nothing saying so. A preference that can
 * starve is not a preference, it is a bug. 26 hours means one missed window is tolerated and a
 * second is not. */
export const MAX_HOURS = 26;

/* A floor, so nothing can sync twice in quick succession.
 *
 * MUST SIT BELOW THE SHORTEST WINDOW-TO-WINDOW GAP, which is 19 hours: a run at 19:59 UTC is only
 * 19h01m before the next window opens at 15:00. A floor of 20 would veto exactly the run the window
 * is asking for and hand control back to the valve — which is how the drift crept back in the first
 * time. 12 is comfortably clear of that while still catching anything pathological. */
export const MIN_HOURS = 12;

/* Is `now` inside the window? Handles a window that wraps midnight, because the day someone moves
   it to 22–04 is not the day to discover the comparison only ever handled from < to. */
export function inWindow(now = Date.now(), [from, to] = WINDOW_UTC) {
  const h = new Date(now).getUTCHours();
  return from <= to ? (h >= from && h < to) : (h >= from || h < to);
}

/* The instant the CURRENT window opened, as ms. Only meaningful when inWindow(now) is true.
 *
 * For a wrapping window (22–04) an early-morning `now` belongs to the window that opened
 * YESTERDAY, so the day has to be stepped back. Getting that wrong would compare against a window
 * start in the future and refuse for ever. */
export function windowStart(now = Date.now(), [from, to] = WINDOW_UTC) {
  const d = new Date(now);
  const wraps = from > to;
  if (wraps && d.getUTCHours() < to) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(from, 0, 0, 0);
  return d.getTime();
}

/* Should a sync run right now?
 *
 * `lastSyncedAt` is max(synced_at) from myob_actuals, or null when the table is empty. Returns a
 * reason either way, because "did not run" with no explanation is the state that gets mistaken for
 * a broken scheduler. */
export function shouldRunNow({
  lastSyncedAt,
  now = Date.now(),
  minHours = MIN_HOURS,
  maxHours = MAX_HOURS,
  windowUtc = WINDOW_UTC,
} = {}) {
  if (!lastSyncedAt) {
    /* NEVER SYNCED. Run, whatever the hour — an empty table means every linked project in the hub
       shows no cost, and waiting until 1am for that is indefensible. */
    return { run: true, reason: 'never synced' };
  }
  const then = new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(then)) {
    /* An unparseable stamp is not a licence to sync repeatedly: treat it as recent and say so, so a
       bad value surfaces as a stalled feed in the health panel rather than as a request loop
       against a live ERP. */
    return { run: false, reason: `last sync time is unreadable (${lastSyncedAt})`, hours: null };
  }
  const hours = (now - then) / 3600000;
  if (hours < 0) {
    /* A stamp in the FUTURE — clock skew, or someone's test data. Refuse rather than sync on every
       tick until real time catches up. */
    return { run: false, reason: `last sync is in the future by ${Math.abs(hours).toFixed(1)}h`, hours };
  }
  /* THE FLOOR comes first, so no path can produce two syncs in quick succession. */
  if (hours < minHours) {
    return { run: false, reason: `synced ${hours.toFixed(1)}h ago, under the ${minHours}h floor`, hours };
  }
  const win = `${windowUtc[0]}:00–${windowUtc[1]}:00 UTC`;
  /* THE WINDOW FIRST, THEN THE VALVE — and the order matters for the REASON, not the decision.
   *
   * Checked valve-first, a run that was both stale AND inside the window reported "past 26h,
   * syncing OUTSIDE the window" while sitting squarely inside it. Traced against the live schedule,
   * that is exactly what the 13/09 01:50 run would have logged. A log line that misdescribes why it
   * ran is how the next person concludes the window is broken and goes looking for a bug that is
   * not there.
   *
   * Safe to reorder: "already synced in this window" implies the last run was inside a window at
   * most five hours wide, so hours is under five and the valve could not have applied anyway. */
  if (inWindow(now, windowUtc)) {
    /* Has this window already had its sync? Anchoring to the window's OPENING rather than to the
       last run is what stops the time drifting: whichever tick within the window gets there first
       does the work, and every later tick sees a stamp newer than the opening and stops. It is also
       what makes a second instance harmless. */
    if (then >= windowStart(now, windowUtc)) {
      return { run: false, reason: `already synced in this ${win} window`, hours };
    }
    return { run: true, reason: `in the ${win} window, last synced ${hours.toFixed(1)}h ago`, hours };
  }
  /* Outside it. The valve is what stops the window starving a service that sleeps through every
     one — without it a preference becomes a bug. */
  if (hours >= maxHours) {
    return {
      run: true, hours,
      reason: `${hours.toFixed(1)}h old and outside the ${win} window — past ${maxHours}h, syncing anyway`,
    };
  }
  return {
    run: false, hours,
    /* Says what would change its mind, so a log full of these does not read as a stuck job. */
    reason: `${hours.toFixed(1)}h old, waiting for the ${win} window (syncs anyway past ${maxHours}h)`,
  };
}

/* A random delay before the first check, in ms.
 *
 * Two instances starting from the same deploy would otherwise tick in the same second, both read
 * the same stale stamp, and both sync. The stamp is the real defence; this makes the window that
 * defeats it vanishingly narrow, by spreading starts across the hour rather than aligning them.
 *
 * `rand` is injectable so the spread is tested rather than hoped for. */
export function startupJitterMs(rand = Math.random) {
  return Math.floor(rand() * CHECK_MS);
}

/* Is the scheduler switched on? OFF unless asked for, so deploying this cannot start making
   requests against a live ERP by surprise — and so a Render Cron Job can be used instead without
   two things syncing. */
export function schedulerEnabled(env = process.env) {
  return String(env.MYOB_SYNC_SCHEDULE || '').trim() === '1';
}
