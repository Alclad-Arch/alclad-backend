// ── THE PURCHASING@ MAILBOX ON A SCHEDULE (Jed 2026-11-10) ─────────────────────────────────────────────────────────
//
// The app keeps a searchable copy of purchasing@ (Supabase function `purchasing-mail`, Microsoft Graph delta). Its design
// said "every 5 minutes", but nothing ever scheduled it: the copy only moved when someone asked the assistant a mailbox
// question, so Sent sat at 4 Nov while POs went out daily. This calls `sync` every 5 minutes with the service key (the
// function's scheduler path — only the server holds that key), and keeps calling within a tick while a folder is still
// catching up (a first copy or a reset pages through 12 months, a few pages per call).
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (live). MAIL_SYNC=off turns it off.

export const EVERY_MS = 5 * 60 * 1000
export const MAX_CALLS_PER_TICK = 10

/* one tick: call sync; while the reply says a folder is still catching up, call again (forced past the once-a-minute
   guard), up to MAX_CALLS_PER_TICK. Returns what happened, for the log. */
export async function syncOnce({ url, key, fetchImpl = fetch, max = MAX_CALLS_PER_TICK } = {}) {
  const calls = []
  for (let i = 0; i < max; i++) {
    const r = await fetchImpl(`${url}/functions/v1/purchasing-mail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sync", force: i > 0 }),
    })
    const j = await r.json().catch(() => ({}))
    calls.push({ status: r.status, ...j })
    if (!r.ok || j.configured === false || j.error || j.skipped) break
    const catching = Object.values(j).some((f) => f && typeof f === "object" && f.catching_up)
    if (!catching) break
  }
  return calls
}

export function summarise(calls) {
  const last = calls[calls.length - 1] || {}
  if (last.configured === false) return "not configured (MS_* secrets)"
  if (last.error || (last.status && last.status >= 400)) return `failed: ${last.error || "HTTP " + last.status}`
  if (last.skipped) return "skipped (synced in the last minute)"
  const sum = { written: 0, removed: 0 }
  for (const c of calls) for (const f of Object.values(c)) if (f && typeof f === "object") { sum.written += f.written || 0; sum.removed += f.removed || 0 }
  const catching = Object.values(last).some((f) => f && typeof f === "object" && f.catching_up)
  return `${calls.length} call${calls.length === 1 ? "" : "s"}, ${sum.written} written, ${sum.removed} removed${catching ? ", still catching up" : ""}`
}

export function startMailSync({ log = console, everyMs = EVERY_MS, env = process.env, fetchImpl = fetch } = {}) {
  if (env.MAIL_SYNC === "off") { log.log("[mail] schedule off (MAIL_SYNC=off)"); return null }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { log.log("[mail] schedule off (no SUPABASE_URL / service key)"); return null }
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { log.log("[mail] " + summarise(await syncOnce({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl }))) }
    catch (e) { log.log("[mail] sync failed: " + (e && e.message)) }
    finally { running = false }
  }
  setTimeout(tick, 20000).unref()   // shortly after start, then every 5 minutes
  const timer = setInterval(tick, everyMs)
  timer.unref()
  log.log(`[mail] schedule on — purchasing@ synced every ${Math.round(everyMs / 60000)} min`)
  return { timer, tick }
}
