// The daily markup review's cron call. Run with: npm test
import assert from "node:assert/strict";
import test from "node:test";
import { callDailyReview, summarise } from "./dailyMarkupReview.js";

const URL_OK = "https://kxxmdjcglkosymcufshb.supabase.co/functions/v1/agents";
const answer = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

test("knocks with the secret header, the daily_review action, and nothing else", async () => {
  let seen;
  const r = await callDailyReview({ url: URL_OK, secret: "s3cret", fetchImpl: async (u, o) => { seen = { u, o }; return answer(200, { pages: 2 })(); } });
  assert.equal(r.ok, true);
  assert.equal(seen.u, URL_OK);
  assert.equal(seen.o.method, "POST");
  assert.equal(seen.o.headers["x-review-secret"], "s3cret");
  assert.equal(seen.o.headers.Authorization, undefined);   // no login: the secret is the door
  assert.deepEqual(JSON.parse(seen.o.body), { action: "daily_review" });
});

test("refuses to send the secret anywhere but an agents function over https", async () => {
  let called = false;
  const f = async () => { called = true; return answer(200, {})(); };
  for (const url of ["http://x.supabase.co/functions/v1/agents", "https://evil.example/collect", "", undefined]) {
    const r = await callDailyReview({ url, secret: "s", fetchImpl: f });
    assert.equal(r.ok, false);
  }
  assert.equal(called, false);
});

test("no secret: fails without calling", async () => {
  const r = await callDailyReview({ url: URL_OK, secret: "", fetchImpl: async () => { throw new Error("should not call"); } });
  assert.equal(r.ok, false);
  assert.match(r.body.error, /AGENTS_REVIEW_SECRET/);
});

test("an HTTP failure or a network error is reported, not thrown", async () => {
  const a = await callDailyReview({ url: URL_OK, secret: "s", fetchImpl: answer(401, { error: "Not authenticated" }) });
  assert.equal(a.ok, false);
  assert.match(summarise(a), /FAILED \(401\): Not authenticated/);
  const b = await callDailyReview({ url: URL_OK, secret: "s", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.match(summarise(b), /FAILED \(no response\): ECONNRESET/);
});

test("the log line says what was checked and whether Eric started", () => {
  const line = summarise({ ok: true, status: 200, body: { pages: 3, waiting: 1, tally: { unchanged: 10, moved: 2, deleted: 1 }, filed: [{}, {}], eric: { run: { id: "r1" } } } });
  assert.equal(line, "daily markup review: 3 page(s) checked, 1 waiting for the next run — 10 unchanged, 2 moved, 0 changed, 0 redrawn, 1 deleted, 0 added; 2 suggestion(s) filed or grown; Eric started");
  assert.match(summarise({ ok: true, body: { pages: 0, eric: null } }), /Eric not needed$/);
  assert.match(summarise({ ok: true, body: { eric: { skipped: "Eric is already on a run" } } }), /Eric skipped: Eric is already on a run$/);
  assert.match(summarise({ ok: true, body: { eric: { error: "Eric AI is switched off on the register" } } }), /Eric NOT started: Eric AI is switched off/);
});
