/* ONE REFRESH PER USER AT A TIME.
 *
 * Jed, twice: "his Salesforce is confirmed connected" / "still not pre-filling" — and the message
 * hiding in the client dropdown was "Salesforce session expired — reconnect". A grant that had
 * just been reconnected, dead again.
 *
 * THE CAUSE is the race that killed the SERVICE grant on 2026-09-14 (serialQueue.js), left
 * unfixed on the per-user path because that is where nobody looked for it. Salesforce rotates a
 * refresh token on use and invalidates the old one, so two concurrent refreshes with the same
 * stored token means the first rotates it, the second is refused, and whichever write lands last
 * can store a token Salesforce has already discarded. Nothing errors at the time — it surfaces as
 * invalid_grant on the NEXT refresh, which is why it reads as "it expired on its own".
 *
 * THE TRIGGER is the proposal screen, which opens with
 *   Promise.allSettled([fetchOppContacts(oppId), fetchOpportunity(oppId, …)])
 * Two parallel reads through the proxy: if the access token has expired both 401 and both refresh
 * at once. Reconnect, open a proposal, grant dies.
 *
 * These tests assert OVERLAP — that two refreshes for one user are never live at the same time —
 * rather than call counts, for the reason serialQueue.test.js already gives: a count can be right
 * while the ordering is wrong, and it is the ordering that destroys the token.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serialQueue } from './serialQueue.js'

/* The refresh, modelled exactly as server.js now does it: a per-user queue, a re-read inside the
   queue, and a rotation that invalidates whatever token was used. If the model and the server ever
   disagree this file is worthless, so it is deliberately the SAME SHAPE and no shorter. */
function makeRefresher({ onOverlap }) {
  const rows = new Map()                 // userId → { refresh_token, access_token }
  const queues = new Map()
  let live = 0
  const q = (id) => { let x = queues.get(id); if (!x) { x = serialQueue(); queues.set(id, x) } return x }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  return {
    rows,
    seed(id, token) { rows.set(id, { refresh_token: token, access_token: 'a0' }) },
    /* Salesforce: using a refresh token rotates it and kills the one presented. A second use of a
       killed token is refused, which is what invalid_grant is. */
    async refresh(userId, rowAtCallTime) {
      return q(userId)(async () => {
        const cur = rows.get(userId)
        if (!cur || !cur.refresh_token) return null
        if (cur.refresh_token !== rowAtCallTime.refresh_token) return cur   // someone else rotated it
        live++
        if (live > 1) onOverlap()
        await sleep(5)                                                       // the round trip
        const used = cur.refresh_token
        if (used.startsWith('dead:')) { live--; return null }                // Salesforce refuses it
        const next = { refresh_token: 'r' + (Number(used.slice(1)) + 1), access_token: 'a' + Date.now() }
        rows.set(userId, next)
        live--
        return next
      })
    },
  }
}

test('two concurrent refreshes for one user never overlap', async () => {
  let overlaps = 0
  const sf = makeRefresher({ onOverlap: () => { overlaps++ } })
  sf.seed('u1', 'r1')
  const row = { ...sf.rows.get('u1') }
  // the proposal screen: two parallel reads, both 401, both refresh
  const [a, b] = await Promise.all([sf.refresh('u1', row), sf.refresh('u1', row)])
  assert.equal(overlaps, 0, 'two refreshes were live at the same time — the grant-killing race')
  assert.ok(a && b, 'both callers got a usable token')
  /* THE POINT: the second caller must NOT have posted the token the first one rotated away. It
     takes the first's result instead, so the stored grant is the live one. */
  assert.equal(a.refresh_token, b.refresh_token, 'the second caller reused the first refresh')
  assert.equal(sf.rows.get('u1').refresh_token, 'r2', 'the row holds exactly one rotation')
})

test('a pile-up of five still rotates once', async () => {
  let overlaps = 0
  const sf = makeRefresher({ onOverlap: () => { overlaps++ } })
  sf.seed('u1', 'r1')
  const row = { ...sf.rows.get('u1') }
  const out = await Promise.all([1, 2, 3, 4, 5].map(() => sf.refresh('u1', row)))
  assert.equal(overlaps, 0)
  assert.equal(sf.rows.get('u1').refresh_token, 'r2', 'five callers, one rotation')
  assert.ok(out.every((x) => x && x.refresh_token === 'r2'), 'every caller got the live token')
})

test('different users are NOT serialised behind each other', async () => {
  /* Per user, not global: one person's Salesforce round trip must not hold up everyone else's.
     Asserted by requiring genuine overlap ACROSS users — the opposite of the within-user rule. */
  const queues = new Map()
  const q = (id) => { let x = queues.get(id); if (!x) { x = serialQueue(); queues.set(id, x) } return x }
  let live = 0, maxLive = 0
  const work = (id) => q(id)(async () => {
    live++; maxLive = Math.max(maxLive, live)
    await new Promise((r) => setTimeout(r, 10))
    live--
  })
  await Promise.all([work('u1'), work('u2'), work('u3')])
  assert.equal(maxLive, 3, 'three users should refresh at the same time, not one after another')
})

test('a refused refresh does not poison the next one', async () => {
  /* The queue swallows rejections on its internal handle only (serialQueue.js). If it did not, one
     user's failed refresh would break every later refresh for that user — a dead grant that stays
     dead even after reconnecting. */
  const sf = makeRefresher({ onOverlap: () => {} })
  sf.seed('u1', 'dead:r1')
  const first = await sf.refresh('u1', { refresh_token: 'dead:r1' })
  assert.equal(first, null, 'Salesforce refused the dead token')
  sf.seed('u1', 'r9')                                   // the user reconnects
  const second = await sf.refresh('u1', { refresh_token: 'r9' })
  assert.ok(second && second.refresh_token === 'r10', 'the next refresh works')
})

test('the server routes per-user refreshes through a per-user queue', async () => {
  /* The model above proves the shape is right; this proves the SERVER uses it. Without this the
     suite passes happily while server.js refreshes unguarded — which is exactly the state that
     shipped between 2026-09-14 and 2026-09-21, with serialQueue.js sitting in the repo. */
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./server.js', import.meta.url), 'utf8')
  const fn = (src.match(/async function refreshSalesforce\(userId, row\)[\s\S]{0,1800}?\n\}/) || [''])[0]
  assert.ok(fn, 'refreshSalesforce not found')
  assert.match(fn, /userQueue\(userId\)\(/, 'the refresh is not queued per user')
  assert.match(fn, /select\("\*"\)\.eq\("user_id", userId\)/, 'the row is not re-read inside the queue')
  assert.match(fn, /cur\.refresh_token !== row\.refresh_token/, 'a rotation by another caller is not detected')
  assert.match(src, /const userQueues = new Map\(\)/, 'no per-user queue map')
  /* The POST itself must be out of the guard function, or a later edit can quietly put the network
     call back above the queue. */
  assert.match(src, /async function refreshSalesforceNow\(userId, row\)/, 'the unguarded refresh should be its own function')
})
