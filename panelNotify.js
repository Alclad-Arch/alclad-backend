// Panel drafting → Teams (part 5, Jed 2026-11-01: "the Teams notice"). When the worker finishes something a person
// has to act on — a draft to review, a draft that needs attention, a set's or a recut's files ready, a run that
// failed — it posts a short card to the team's channel through its webhook, linking straight to the page in the app.
//
// Env: PANEL_TEAMS_WEBHOOK (the channel's webhook URL — a Teams Workflows "post to a channel when a webhook request is
// received" URL, or a classic Incoming Webhook; both take this Adaptive Card shape) · PANEL_APP_URL (default
// https://alclad.app). No webhook set = nothing is posted, nothing breaks. A post that fails is logged, never retried
// into the run: the drafting itself succeeded.

const APP = () => (process.env.PANEL_APP_URL || "https://alclad.app").replace(/\/+$/, "");

/* What happened → the card's title, line and link. Pure, so panelNotify.test.js holds it.
   ev: { kind: 'draft'|'release'|'recut'|'failed', job: {id,name}, draft?: {id,rev,review_status,questions}, set?: {no,label,set_m2},
         recut?: {no,panel_ids,reason,m2}, mode?, error? } */
export function cardFor(ev) {
  const job = (ev.job && ev.job.name) || "A panel job";
  const base = `${APP()}/production/cladding/panels/job/${encodeURIComponent((ev.job && ev.job.id) || "")}`;
  if (ev.kind === "draft") {
    const d = ev.draft || {};
    const attention = !/^awaiting review$/i.test(String(d.review_status || ""));
    const qs = Number(d.questions) || 0;
    return {
      title: attention ? `⚠ Draft needs attention — ${job}` : `Draft ready for review — ${job}`,
      line: attention ? `Rev ${d.rev || 1}: ${d.review_status || "needs attention"}. Open it to see what the drafter couldn't do.`
        : `Rev ${d.rev || 1} is drawn${qs ? `, with ${qs} question${qs === 1 ? "" : "s"} to answer` : ""}. Check it and approve or answer.`,
      url: `${base}/draft/${encodeURIComponent(d.id || "")}`,
    };
  }
  if (ev.kind === "release") {
    const s = ev.set || {};
    return { title: `Set ${s.no} released — ${job}`, line: `Set ${s.no}${s.label ? ` "${s.label}"` : ""}${s.set_m2 != null ? `, ${Number(s.set_m2).toFixed(1)} m²` : ""}: its files are ready. Mark it cut when it's being cut.`, url: base };
  }
  if (ev.kind === "recut") {
    const r = ev.recut || {}, s = ev.set || {};
    return { title: `Recut ready — ${job}`, line: `Set ${s.no} recut ${String(r.no || 1).padStart(2, "0")} (${(r.panel_ids || []).join(", ")}${r.reason ? ` — ${r.reason}` : ""})${r.m2 != null ? `, ${Number(r.m2).toFixed(1)} m²` : ""}: its files are ready.`, url: base };
  }
  const what = ev.mode === "release" ? "A release" : ev.mode === "recut" ? "A recut" : ev.mode === "redraw" ? "A redraw" : "A draft";
  return { title: `⚠ ${what} failed — ${job}`, line: `${String(ev.error || "No reason given").slice(0, 300)} — open it and Try again, or tell Jed.`, url: base };
}

/* The webhook body: one Adaptive Card — what both Teams webhook kinds accept. */
export function teamsBody(card) {
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
        body: [
          { type: "TextBlock", text: card.title, weight: "Bolder", size: "Medium", wrap: true },
          { type: "TextBlock", text: card.line, wrap: true },
        ],
        actions: [{ type: "Action.OpenUrl", title: "Open in alclad.app", url: card.url }],
      },
    }],
  };
}

/* Post it — quietly: no webhook set, or a post that fails, never fails the run. */
export async function notifyTeams(ev, { fetchImpl = fetch, log = console, env = process.env } = {}) {
  const url = env.PANEL_TEAMS_WEBHOOK;
  if (!url) return { sent: false, why: "no webhook" };
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(teamsBody(cardFor(ev))) });
    if (!res.ok) { log.error(`[panels] Teams post refused: ${res.status}`); return { sent: false, why: `HTTP ${res.status}` }; }
    return { sent: true };
  } catch (e) { log.error(`[panels] Teams post failed: ${e.message || e}`); return { sent: false, why: String(e.message || e) }; }
}
