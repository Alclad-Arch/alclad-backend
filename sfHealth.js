/* How healthy is a stored Salesforce grant — answered WITHOUT asking Salesforce.
 *
 * Jed 2026-09-21: "These can be a bit misleading sometimes causing you to think you are connected
 * when in fact your connection has expired."
 *
 * He is describing a specific lie with a line number. /api/auth/status answered
 * `authenticated: Boolean(row)` — the mere existence of a salesforce_tokens row — and a row
 * outlives the grant it holds. src/salesforce.jsx:115 in the app has carried a note about the
 * consequence since 2026-09-11: a dead row with somebody else's Salesforce username had the
 * opportunity picker reading "Salesforce connected as nathan@alcladaus.com.au" while the path
 * that actually used that row returned 401.
 *
 * ⚠ THE OBVIOUS FIX IS THE DANGEROUS ONE. The honest test of a refresh token is to use it, and
 * using it ROTATES it — Salesforce invalidates the old one. A health check that refreshed would
 * therefore rotate every grant it inspected, and an admin opening a panel listing twelve users
 * would put twelve working connections through a rotation nobody asked for. The service-account
 * check had exactly that bug built into it once and it was removed for this reason: never let a
 * diagnostic perform a rotating refresh.
 *
 * So nothing here calls out. Every field it reads was recorded by server.js at the moment a real
 * refresh succeeded or failed, which is the only time the truth is available for free.
 *
 * Pure and dependency-free so the SAME rule answers the admin list and the user's own status —
 * two surfaces that must never disagree about what "connected" means.
 */

/* Org-enforced and Support-only to change: Salesforce expires a refresh token that has not been
   USED for 30 days. Raising it was already rejected (the External Client App's "Limit Idle Refresh
   Token TTL to 30 Days" is ticked and locked), so this is a fact to design around, not a setting. */
export const SF_IDLE_DAYS = 30;
/* How long before that deadline to start saying so. A week is enough to catch somebody before a
   proposal is due and short enough that the warning still means something when it appears. */
export const SF_WARN_DAYS = 7;

export const SF_STATES = ["none", "failing", "expired", "expiring", "ok"];

/* `row` is a salesforce_tokens row (or null). `now` is injected so the rules are testable without
   waiting thirty days — the same reason `today` is a parameter throughout the app's SOAP model. */
export function sfGrantHealth(row, now = Date.now()) {
  if (!row) return { state: "none" };

  const at = (v) => {
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const ok = at(row.last_ok_at);
  const bad = at(row.last_error_at);
  /* ⚠ THE IDLE CLOCK IS `updated_at`, and it already existed. Every successful refresh writes it,
     and Salesforce's 30 days runs from the last USE of the refresh token — so days since it is the
     real countdown and no new column was needed to track one. Falls back to last_ok_at only for a
     row written before those columns existed. */
  const used = at(row.updated_at) ?? ok;
  const daysSinceUse = used == null ? null : Math.floor((now - used) / 86400000);

  const base = {
    state: "ok",
    username: row.sf_username || null,
    lastOkAt: row.last_ok_at || null,
    lastErrorAt: row.last_error_at || null,
    error: row.last_error || null,
    errorDescription: row.last_error_desc || null,
    daysSinceUse,
    expiresInDays: daysSinceUse == null ? null : SF_IDLE_DAYS - daysSinceUse,
  };

  /* A FAILURE WITH NOTHING NEWER TO OVERRULE IT, checked first. An expiry countdown printed over a
     grant that is already refusing to refresh is a distraction from the reason sitting right
     there — and Salesforce's own error_description is the only thing that separates revoked from
     expired from IP-blocked, which is why it is carried rather than summarised. */
  if (bad != null && (ok == null || bad > ok)) return { ...base, state: "failing" };
  if (daysSinceUse != null && daysSinceUse >= SF_IDLE_DAYS) return { ...base, state: "expired" };
  if (daysSinceUse != null && daysSinceUse >= SF_IDLE_DAYS - SF_WARN_DAYS) return { ...base, state: "expiring" };
  return base;
}

/* Is this grant usable right now? `expiring` is deliberately TRUE: it still works, and treating a
   working connection as broken would send people to reconnect for no reason and teach them to
   ignore the warning that matters. */
export function sfGrantUsable(health) {
  return !!health && (health.state === "ok" || health.state === "expiring");
}

/* One sentence, written here rather than in each surface so the admin panel and the user's own
   banner cannot end up describing the same state differently. */
export function sfGrantSummary(health) {
  if (!health) return "";
  const d = health.daysSinceUse;
  switch (health.state) {
    case "none":
      return "Not connected.";
    case "failing":
      return `Salesforce refused the last refresh${health.error ? ` (${health.error})` : ""}`
        + `${health.errorDescription ? ` — ${health.errorDescription}` : ""}. Reconnect to fix it.`;
    case "expired":
      return `Unused for ${d} days, past the ${SF_IDLE_DAYS}-day limit — this connection has expired. Reconnect to fix it.`;
    case "expiring":
      return `Unused for ${d} days. Salesforce drops a connection after ${SF_IDLE_DAYS}, so this one has about `
        + `${Math.max(0, health.expiresInDays)} day${health.expiresInDays === 1 ? "" : "s"} left unless it is used.`;
    default:
      return d == null ? "Working." : `Working — last used ${d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"} ago`}.`;
  }
}
