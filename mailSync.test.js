// The purchasing@ mailbox schedule (mailSync.js) — Jed 2026-11-10: the copy only moved when someone asked the assistant.
import test from "node:test"
import assert from "node:assert/strict"
import { syncOnce, summarise, startMailSync } from "./mailSync.js"

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
const fake = (replies) => { const seen = []; return { seen, fetchImpl: async (url, opts) => { seen.push({ url, opts: { ...opts, body: JSON.parse(opts.body) } }); return reply(...replies.shift()) } } }

test("calls the function with the service key, as the scheduler", async () => {
  const f = fake([[{ configured: true, inbox: { written: 2, catching_up: false }, sent: { written: 5, catching_up: false } }]])
  const calls = await syncOnce({ url: "https://x.supabase.co", key: "svc", fetchImpl: f.fetchImpl })
  assert.equal(f.seen.length, 1)
  assert.equal(f.seen[0].url, "https://x.supabase.co/functions/v1/purchasing-mail")
  assert.equal(f.seen[0].opts.headers.Authorization, "Bearer svc")
  assert.deepEqual(f.seen[0].opts.body, { action: "sync", force: false })
  assert.equal(summarise(calls), "1 call, 7 written, 0 removed")
})

test("keeps calling (forced) while a folder is catching up — a reset re-reads 12 months in one tick", async () => {
  const f = fake([
    [{ configured: true, inbox: { written: 0 }, sent: { written: 50, catching_up: true } }],
    [{ configured: true, inbox: { written: 0 }, sent: { written: 50, catching_up: true } }],
    [{ configured: true, inbox: { written: 0 }, sent: { written: 20, catching_up: false } }],
  ])
  const calls = await syncOnce({ url: "u", key: "k", fetchImpl: f.fetchImpl })
  assert.equal(calls.length, 3)
  assert.deepEqual(f.seen.map((s) => s.opts.body.force), [false, true, true])
  assert.equal(summarise(calls), "3 calls, 120 written, 0 removed")
})

test("stops at the cap, and says it's still catching up", async () => {
  const f = fake(Array.from({ length: 5 }, () => [{ configured: true, sent: { written: 50, catching_up: true } }]))
  const calls = await syncOnce({ url: "u", key: "k", fetchImpl: f.fetchImpl, max: 3 })
  assert.equal(calls.length, 3)
  assert.match(summarise(calls), /still catching up/)
})

test("an error, a refusal or no Microsoft setup stops the tick and is reported", async () => {
  for (const [body, status, re] of [[{ error: "Microsoft refused the app sign-in" }, 502, /failed: Microsoft refused/], [{ configured: false }, 200, /not configured/], [{ error: "Not authenticated" }, 401, /failed/]]) {
    const f = fake([[body, status]])
    const calls = await syncOnce({ url: "u", key: "k", fetchImpl: f.fetchImpl })
    assert.equal(calls.length, 1)
    assert.match(summarise(calls), re)
  }
})

test("off without the service key, or with MAIL_SYNC=off", () => {
  const log = { log: () => {} }
  assert.equal(startMailSync({ log, env: {} }), null)
  assert.equal(startMailSync({ log, env: { SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k", MAIL_SYNC: "off" } }), null)
})
