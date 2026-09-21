/* A CONNECTION THAT READS AS LIVE WHEN IT IS DEAD.
 *
 * Jed 2026-09-21: "These can be a bit misleading sometimes causing you to think you are connected
 * when in fact your connection has expired." The cause was one expression —
 * /api/auth/status answering `authenticated: Boolean(row)` — and a salesforce_tokens row outlives
 * the grant inside it. The app has carried a note about the consequence since 2026-09-11
 * (src/salesforce.jsx:115): a dead row said "Salesforce connected as nathan@alcladaus.com.au"
 * while the path that used it returned 401.
 *
 * These tests are about the two ways a grant dies QUIETLY — a refused refresh, and thirty days of
 * not being used — and about the one thing the fix must never do, which is ask Salesforce.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sfGrantHealth, sfGrantUsable, sfGrantSummary, SF_IDLE_DAYS } from './sfHealth.js'

const NOW = Date.parse('2026-09-21T10:00:00Z')
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString()

test('no row is "not connected", not a broken connection', () => {
  const h = sfGrantHealth(null, NOW)
  assert.equal(h.state, 'none')
  assert.equal(sfGrantUsable(h), false)
  assert.equal(sfGrantSummary(h), 'Not connected.')
})

test('a refresh that succeeded recently is working', () => {
  const h = sfGrantHealth({ updated_at: daysAgo(1), last_ok_at: daysAgo(1), sf_username: 'jed@alcladaus.com.au' }, NOW)
  assert.equal(h.state, 'ok')
  assert.equal(sfGrantUsable(h), true)
  assert.equal(h.username, 'jed@alcladaus.com.au')
  assert.match(sfGrantSummary(h), /Working — last used 1 day ago/)
})

test('⚠ a REFUSED refresh is reported as failing, and carries Salesforce\'s own words', () => {
  /* invalid_grant alone cannot distinguish revoked from expired from IP-blocked. Only
     error_description can, which is the whole reason it is stored rather than summarised — the
     app printed a guessed remedy for four different situations three times before this. */
  const h = sfGrantHealth({
    updated_at: daysAgo(3), last_ok_at: daysAgo(3),
    last_error: 'invalid_grant', last_error_desc: 'expired access/refresh token', last_error_at: daysAgo(1),
  }, NOW)
  assert.equal(h.state, 'failing')
  assert.equal(sfGrantUsable(h), false)
  assert.equal(h.error, 'invalid_grant')
  assert.match(sfGrantSummary(h), /invalid_grant/)
  assert.match(sfGrantSummary(h), /expired access\/refresh token/)
})

test('⚠ a success AFTER a failure clears it — a stale error must not condemn a working grant', () => {
  const h = sfGrantHealth({
    updated_at: daysAgo(1), last_ok_at: daysAgo(1),
    last_error: 'invalid_grant', last_error_desc: 'x', last_error_at: daysAgo(5),
  }, NOW)
  assert.equal(h.state, 'ok')
  assert.equal(sfGrantUsable(h), true)
})

test('a failure with no success ever recorded is still failing', () => {
  const h = sfGrantHealth({ updated_at: daysAgo(40), last_error: 'invalid_grant', last_error_at: daysAgo(2) }, NOW)
  assert.equal(h.state, 'failing')
})

test('⚠ THE SILENT ONE: unused for 30 days is expired, however healthy the row looks', () => {
  /* No error, a username, a perfectly ordinary row — and Salesforce dropped the grant on day 30.
     This is the state that reads as connected and is not, and it is invisible without the clock. */
  const h = sfGrantHealth({ updated_at: daysAgo(31), last_ok_at: daysAgo(31), sf_username: 'x@y.com' }, NOW)
  assert.equal(h.state, 'expired')
  assert.equal(sfGrantUsable(h), false)
  assert.equal(h.error, null, 'nothing failed — that is exactly why it is invisible')
  assert.match(sfGrantSummary(h), /past the 30-day limit/)
})

test('⚠ the week before that says so, while the connection still WORKS', () => {
  const h = sfGrantHealth({ updated_at: daysAgo(25), last_ok_at: daysAgo(25) }, NOW)
  assert.equal(h.state, 'expiring')
  assert.equal(sfGrantUsable(h), true, 'it still works — telling people to reconnect now would teach them to ignore this')
  assert.equal(h.expiresInDays, 5)
  assert.match(sfGrantSummary(h), /about 5 days left/)
})

test('the boundary days are on the right side of the line', () => {
  assert.equal(sfGrantHealth({ updated_at: daysAgo(22) }, NOW).state, 'ok')
  assert.equal(sfGrantHealth({ updated_at: daysAgo(23) }, NOW).state, 'expiring')
  assert.equal(sfGrantHealth({ updated_at: daysAgo(29) }, NOW).state, 'expiring')
  assert.equal(sfGrantHealth({ updated_at: daysAgo(30) }, NOW).state, 'expired')
})

test('⚠ a failure OUTRANKS the expiry countdown — the reason beats the clock', () => {
  const h = sfGrantHealth({ updated_at: daysAgo(40), last_error: 'invalid_grant', last_error_at: daysAgo(1) }, NOW)
  assert.equal(h.state, 'failing', 'a countdown printed over a grant already refusing to refresh hides the answer')
})

test('a row with unreadable dates does not throw or invent a countdown', () => {
  const h = sfGrantHealth({ updated_at: 'not a date', last_ok_at: null }, NOW)
  assert.equal(h.daysSinceUse, null)
  assert.equal(h.expiresInDays, null)
  assert.equal(h.state, 'ok', 'unknown is not broken')
})

test('the idle limit is the org-enforced 30 days, not a number someone picked', () => {
  assert.equal(SF_IDLE_DAYS, 30)
})

/* ── the rule the whole design rests on ──────────────────────────────────────────────────────
 *
 * The honest test of a refresh token is to USE it, and using it rotates it — Salesforce
 * invalidates the old one. So a health check that refreshed would rotate every grant it looked
 * at, and an admin opening a list of twelve users would rotate twelve working connections.
 * That bug was built into the service-account check once and removed. A unit test cannot prove a
 * network call is absent at runtime, but it can prove this module has no way to make one.
 */
test('⚠ sfHealth.js CANNOT reach Salesforce — a diagnostic must never rotate what it inspects', () => {
  const src = readFileSync(new URL('./sfHealth.js', import.meta.url), 'utf8')
  for (const forbidden of ['fetch(', 'http', 'supabase', 'import ']) {
    assert.equal(src.includes(forbidden), false,
      `sfHealth.js contains "${forbidden}" — it must stay pure, or a health check can start refreshing grants`)
  }
})

test('⚠ the admin connections route does not refresh either, and is gated on ADMIN not on SF access', () => {
  const src = readFileSync(new URL('./server.js', import.meta.url), 'utf8')
  const route = src.slice(src.indexOf('app.get("/api/salesforce/connections"'))
  const body = route.slice(0, route.indexOf('\n});'))
  assert.ok(body.length > 0, 'the connections route is missing')
  for (const forbidden of ['refreshSalesforce', 'sfFetch', 'oauth2/token']) {
    assert.equal(body.includes(forbidden), false, `the connections route calls ${forbidden} — it must only READ recorded state`)
  }
  /* requireUser tests SF_ALLOWED_ROLES, which answers "who may use Salesforce". Widening that to
     estimators one day must not hand every estimator a roster of their colleagues' connections. */
  assert.match(body, /super_admin/, 'the connections list must check the admin role explicitly, not rely on SF_ALLOWED_ROLES')
})

test('⚠ a failed refresh RECORDS why, and a successful one clears it', () => {
  const src = readFileSync(new URL('./server.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('async function refreshSalesforceNow'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.match(body, /last_error_at/, 'a failed refresh must write down why, or the panel is guessing again')
  assert.match(body, /error_description/, 'Salesforce\'s description is the only thing that separates revoked from expired')
  assert.match(body, /last_ok_at/, 'a success must be recorded, or every grant reads as never-working')
  assert.match(body, /last_error: null/, 'a success must CLEAR the old error, or a working grant reads as broken')
})
