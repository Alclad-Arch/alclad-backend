// The daily markup review — run by a Render Cron Job, early each morning.
//
// Jed 2026-10-29 (Eric's markup-review skill, "use the Render cron"): once a day, compare every
// newly Complete takeoff page's agent markups with what people confirmed, record the outcomes, file
// the suggestions, and start Eric AI to write the proposed wording. All of that happens in alclad.app's
// `agents` edge function (supabase/functions/agents, action "daily review"); this only knocks on its
// door with the shared secret, says what came back, and exits non-zero on a failure so Render's
// cron history shows it.
//
// WHY A CRON JOB AND NOT A TIMER IN server.js: the web service is on a plan that sleeps when idle,
// so an in-process timer at 4am would wake to find nobody had called it (see syncSchedule.js on the
// free tier). A Render Cron Job is its own short-lived process, started on schedule whether or not
// the web service is awake.
//
// Render → New → Cron Job, this repo:
//   Command   node dailyMarkupReview.js
//   Schedule  0 18 * * *        (18:00 UTC = 4am in Melbourne at AEST, 5am at AEDT)
//   Env       AGENTS_FUNCTION_URL  https://<project ref>.supabase.co/functions/v1/agents
//             AGENTS_REVIEW_SECRET the same value as the agents function's AGENTS_REVIEW_SECRET secret
//
// Run by hand: AGENTS_FUNCTION_URL=… AGENTS_REVIEW_SECRET=… node dailyMarkupReview.js
import "dotenv/config";
import { pathToFileURL } from "node:url";

/* Call the agents function's daily review. Returns { ok, status, body } — never throws for an HTTP
   failure, so the caller can say what went wrong. `fetchImpl` is injectable for the tests. */
export async function callDailyReview({ url, secret, fetchImpl = fetch, timeoutMs = 280000 } = {}) {
  if (!url || !/^https:\/\/[^/]+\/functions\/v1\/agents$/.test(url)) {
    return { ok: false, status: 0, body: { error: "AGENTS_FUNCTION_URL must be https://<ref>.supabase.co/functions/v1/agents" } };
  }
  if (!secret) return { ok: false, status: 0, body: { error: "AGENTS_REVIEW_SECRET is not set" } };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-review-secret": secret },
      body: JSON.stringify({ action: "daily_review" }),
      signal: ctl.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e && e.name === "AbortError" ? `no answer in ${Math.round(timeoutMs / 1000)}s` : String((e && e.message) || e) } };
  } finally {
    clearTimeout(t);
  }
}

/* One line for the cron log: what was checked, and whether Eric was started. */
export function summarise(r) {
  if (!r.ok) return `daily markup review FAILED (${r.status || "no response"}): ${(r.body && r.body.error) || "unknown error"}`;
  const b = r.body || {};
  const t = b.tally || {};
  const eric = !b.eric ? "Eric not needed"
    : b.eric.skipped ? `Eric skipped: ${b.eric.skipped}`
    : b.eric.error ? `Eric NOT started: ${b.eric.error}`
    : "Eric started";
  return `daily markup review: ${b.pages || 0} page(s) checked${b.waiting ? `, ${b.waiting} waiting for the next run` : ""}`
    + ` — ${t.unchanged || 0} unchanged, ${t.moved || 0} moved, ${t.changed || 0} changed, ${t.redrawn || 0} redrawn, ${t.deleted || 0} deleted, ${t.added || 0} added`
    + `; ${(b.filed || []).length} suggestion(s) filed or grown; ${eric}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const r = await callDailyReview({ url: process.env.AGENTS_FUNCTION_URL, secret: process.env.AGENTS_REVIEW_SECRET });
  console.log(summarise(r));
  process.exit(r.ok ? 0 : 1);
}
