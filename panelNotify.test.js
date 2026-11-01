// The Teams notice (part 5, Jed 2026-11-01): what each card says, its link, the webhook body, and that it never
// breaks a run — no webhook, a refused post, a network error.
import assert from "node:assert/strict";
import test from "node:test";
import { cardFor, teamsBody, notifyTeams } from "./panelNotify.js";

const job = { id: "pj_1", name: "6197 Storage King Croydon" };
const quiet = { log() {}, error() {} };

test("a draft ready for review: title, its questions, a link to the draft", () => {
  const c = cardFor({ kind: "draft", job, draft: { id: "d7", rev: 2, review_status: "awaiting review", questions: 3 } });
  assert.equal(c.title, "Draft ready for review — 6197 Storage King Croydon");
  assert.match(c.line, /^Rev 2 is drawn, with 3 questions to answer/);
  assert.equal(c.url, "https://alclad.app/production/cladding/panels/job/pj_1/draft/d7");
});

test("a draft that needs attention says so", () => {
  const c = cardFor({ kind: "draft", job, draft: { id: "d8", rev: 1, review_status: "needs attention - not drawn" } });
  assert.match(c.title, /^⚠ Draft needs attention/);
  assert.match(c.line, /needs attention - not drawn/);
});

test("a set released, and a recut ready, link to the job", () => {
  const r = cardFor({ kind: "release", job, set: { no: 2, label: "South", set_m2: 38.2 } });
  assert.equal(r.title, "Set 2 released — 6197 Storage King Croydon"); assert.match(r.line, /Set 2 "South", 38\.2 m²: its files are ready/);
  assert.equal(r.url, "https://alclad.app/production/cladding/panels/job/pj_1");
  const x = cardFor({ kind: "recut", job, set: { no: 2 }, recut: { no: 1, panel_ids: ["S-01", "S-02"], reason: "damaged on site", m2: 2.4 } });
  assert.match(x.line, /^Set 2 recut 01 \(S-01, S-02 — damaged on site\), 2\.4 m²: its files are ready/);
});

test("a failure names what failed and why", () => {
  const c = cardFor({ kind: "failed", job, mode: "release", error: "The release returned no result.json" });
  assert.equal(c.title, "⚠ A release failed — 6197 Storage King Croydon"); assert.match(c.line, /no result\.json/);
});

test("PANEL_APP_URL changes the link", () => {
  process.env.PANEL_APP_URL = "https://dev.example/";
  try { assert.equal(cardFor({ kind: "release", job, set: { no: 1 } }).url, "https://dev.example/production/cladding/panels/job/pj_1"); }
  finally { delete process.env.PANEL_APP_URL; }
});

test("the webhook body: one Adaptive Card, title, line, an Open button", () => {
  const b = teamsBody({ title: "T", line: "L", url: "https://x/y" });
  assert.equal(b.type, "message"); assert.equal(b.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
  const card = b.attachments[0].content;
  assert.deepEqual(card.body.map((x) => x.text), ["T", "L"]); assert.equal(card.actions[0].url, "https://x/y");
});

test("Ask Pete (step 3): every card's first button opens Pete's chat on the job — a draft's on that draft — the page second", () => {
  const d = cardFor({ kind: "draft", job, draft: { id: "d7", rev: 2, review_status: "awaiting review", questions: 1 } });
  assert.equal(d.pete, "https://alclad.app/pete?job=pj_1&draft=d7");
  assert.equal(cardFor({ kind: "release", job, set: { no: 1 } }).pete, "https://alclad.app/pete?job=pj_1");
  assert.equal(cardFor({ kind: "failed", job, mode: "draft", error: "x" }).pete, "https://alclad.app/pete?job=pj_1");
  const acts = teamsBody(d).attachments[0].content.actions;
  assert.deepEqual(acts.map((a) => [a.title, a.url]), [["Ask Pete", "https://alclad.app/pete?job=pj_1&draft=d7"], ["Open the page", "https://alclad.app/production/cladding/panels/job/pj_1/draft/d7"]]);
});

test("posting: sent with the webhook; no webhook, a refusal or a network error never throws", async () => {
  const sent = [];
  const ok = await notifyTeams({ kind: "release", job, set: { no: 1 } }, { env: { PANEL_TEAMS_WEBHOOK: "https://hook" }, fetchImpl: async (u, o) => { sent.push([u, JSON.parse(o.body)]); return { ok: true }; }, log: quiet });
  assert.deepEqual(ok, { sent: true }); assert.equal(sent[0][0], "https://hook");
  assert.equal((await notifyTeams({ kind: "release", job }, { env: {}, log: quiet })).why, "no webhook");
  assert.equal((await notifyTeams({ kind: "release", job }, { env: { PANEL_TEAMS_WEBHOOK: "https://hook" }, fetchImpl: async () => ({ ok: false, status: 400 }), log: quiet })).why, "HTTP 400");
  assert.match((await notifyTeams({ kind: "release", job }, { env: { PANEL_TEAMS_WEBHOOK: "https://hook" }, fetchImpl: async () => { throw new Error("offline"); }, log: quiet })).why, /offline/);
});
