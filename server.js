// server.js — Salesforce OAuth backend for the Alclad app.
//
// Identity = the caller's Supabase JWT (Authorization: Bearer <jwt>), verified with the
// service-role key. Salesforce tokens are stored per app-user in Supabase (salesforce_tokens,
// backend-only via RLS). No cookies / no server session: the OAuth handshake carries the user +
// PKCE verifier through a short-lived sf_oauth_pending row keyed by `state`.
//
// .env template:
//   SF_CLIENT_ID=your_consumer_key
//   SF_CLIENT_SECRET=your_consumer_secret
//   SF_LOGIN_URL=https://login.salesforce.com
//   SF_CALLBACK_URL=https://alclad-backend.onrender.com/api/oauth/callback   (backend origin)
//   APP_REDIRECT_URL=https://alclad.app/budget-calc                           (where to land after connect)
//   ALLOWED_ORIGINS=https://alclad.app,http://localhost:5173                  (CORS allow-list)
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=service_role_key   (backend only — never ship to the browser)
//   SF_ALLOWED_ROLES=super_admin,admin           (user_profiles.role values allowed to use Salesforce;
//                                                 UNSET = every authenticated app user is allowed)
//   TOKEN_ENC_KEY=<32 bytes, base64 or hex>      (encrypts Salesforce tokens at rest; see "Encryption" below)
//   SF_RATE_PER_MIN=60                           (per-user proxy calls per minute; default 60)
//   SF_RATE_PER_DAY=1000                         (per-user proxy calls per day; default 1000)
//   NODE_ENV=production
//   For LOCAL dev: SF_CALLBACK_URL=http://localhost:3001/api/oauth/callback (register it in the SF app too).

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { loadKey, isSealed, seal as sealWith, unseal as unsealWith } from "./tokenCrypto.js";
import { buildSummaryQuery, shapeSummary } from "./oppSummary.js";
import { syncActuals } from "./syncMyobActuals.js";
import { schedulerEnabled, startupJitterMs, CHECK_MS } from "./syncSchedule.js";

const app = express();

// Service-role Supabase client — bypasses RLS, so it's the only thing that can read/write the
// backend-only tables. Held server-side; never exposed to the frontend.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

app.disable("x-powered-by");

// CORS is a browser-only control (auth here is a bearer header, so it stops nothing for a
// non-browser caller) — but don't hand localhost to production. In production the origins
// must be configured explicitly; the dev default only applies outside production.
const IS_PROD = process.env.NODE_ENV === "production";
const ALLOWED = (process.env.ALLOWED_ORIGINS || (IS_PROD ? "https://alclad.app" : "https://alclad.app,http://localhost:5173"))
  .split(",").map((s) => s.trim()).filter(Boolean);
if (IS_PROD && !process.env.ALLOWED_ORIGINS) console.warn("[security] ALLOWED_ORIGINS not set — defaulting to https://alclad.app only");
app.use(cors({
  origin: ALLOWED,
  methods: ["GET", "POST", "OPTIONS"],   // nothing here mutates Salesforce; no PUT/PATCH/DELETE
  allowedHeaders: ["Authorization", "Content-Type"],
}));
app.use(express.json({ limit: "100kb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const base64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const PENDING_TTL_MS = 10 * 60 * 1000;   // OAuth handshake window

// ── Encryption at rest for Salesforce tokens ────────────────────────────────────────
//
// RLS already keeps salesforce_tokens away from the browser, so this is defence in depth:
// it means a database dump, a restored backup, or a leaked read-only Postgres credential
// yields ciphertext rather than live Salesforce refresh tokens. The key lives only in the
// Render environment, so an attacker needs BOTH the database and the app environment.
// (Mechanics and format live in tokenCrypto.js, alongside its tests.)
//
// Rollout is deliberately non-breaking: with TOKEN_ENC_KEY unset the service stores
// plaintext exactly as before, and decryption always accepts plaintext, so setting the key
// on a live deployment does not invalidate existing connections — each row is re-encrypted
// the next time it's read. Losing the key is recoverable: users reconnect via OAuth.
const ENC_KEY = loadKey(process.env.TOKEN_ENC_KEY);
if (!ENC_KEY) {
  console.warn("[security] TOKEN_ENC_KEY is not set — Salesforce tokens are stored in PLAINTEXT. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
}
const seal = (plain, userId) => sealWith(plain, userId, ENC_KEY);
const unseal = (value, userId) => {
  if (isSealed(value) && !ENC_KEY) { console.error("[security] encrypted token found but TOKEN_ENC_KEY is not set"); return null; }
  const out = unsealWith(value, userId, ENC_KEY);
  if (out === null && isSealed(value)) console.error("[security] token decryption failed — wrong key, or the row was tampered with");
  return out;
};

// Decrypt a salesforce_tokens row in place, and opportunistically re-encrypt rows that are
// still plaintext from before the key was introduced.
function openRow(row, userId) {
  if (!row) return null;
  const access_token = unseal(row.access_token, userId);
  const refresh_token = unseal(row.refresh_token, userId);
  if (access_token === null || refresh_token === null) return null;   // undecryptable → reconnect
  if (ENC_KEY && (!isSealed(row.access_token) || !isSealed(row.refresh_token))) {
    supabaseAdmin.from("salesforce_tokens")
      .update({ access_token: seal(access_token, userId), refresh_token: seal(refresh_token, userId) })
      .eq("user_id", userId)
      .then(() => console.log("migrated plaintext Salesforce tokens to encrypted"), () => {});
  }
  return { ...row, access_token, refresh_token };
}

// ── Audit trail ─────────────────────────────────────────────────────────────────────
//
// Every Salesforce touch is recorded: who, what, and the outcome. Without it a stolen
// session is invisible after the fact — there is no way to answer "what did they pull, and
// when did it start". Writes are fire-and-forget so auditing can never fail a request or
// add latency to the proxy hot path.
//
// `detail` holds the request path INCLUDING the SOQL, truncated — that is the point of the
// log (it's what makes an exfiltration attempt legible), but it also means the table can
// contain fragments of CRM data, so it is backend-only and pruned on a retention window.
const AUDIT_RETAIN_DAYS = 90;
let _lastPrune = 0;

function audit(req, action, detail, status) {
  const row = {
    user_id: req?.userId || null,
    action,
    detail: detail == null ? null : String(detail).slice(0, 500),
    status: status ?? null,
    // Render sits behind a proxy, so the socket address is the proxy's; the client is at
    // the head of x-forwarded-for. Untrusted (spoofable upstream of Render) — recorded as a
    // hint, never used for a decision.
    ip: String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || null,
  };
  supabaseAdmin.from("sf_audit_log").insert(row).then(
    () => {},
    (e) => console.error("audit write failed:", e && e.message)
  );

  if (Date.now() - _lastPrune > 6 * 60 * 60 * 1000) {          // at most once every 6h
    _lastPrune = Date.now();
    supabaseAdmin.from("sf_audit_log")
      .delete().lt("at", new Date(Date.now() - AUDIT_RETAIN_DAYS * 864e5).toISOString())
      .then(() => {}, () => {});
  }
}

// ── Per-user rate limiting ──────────────────────────────────────────────────────────
//
// The proxy is read-only, but read-only is exactly what an IP theft looks like: SOQL can
// page the whole CRM out through it. These caps bound how much a stolen session can take
// before the daily limit trips and the audit log shows a burst.
//
// In-memory and therefore PER INSTANCE — on a single Render instance that is the whole
// service; if this is ever scaled out the effective limit multiplies by the instance count,
// at which point this needs to move into Postgres or Redis.
const RATE_PER_MIN = Number(process.env.SF_RATE_PER_MIN || 60);
const RATE_PER_DAY = Number(process.env.SF_RATE_PER_DAY || 1000);
const _buckets = new Map();   // userId → { min: {n, resetAt}, day: {n, resetAt} }

function rateLimit({ perMin, perDay, action }) {
  return (req, res, next) => {
    const now = Date.now();
    let b = _buckets.get(req.userId);
    if (!b) { b = { min: { n: 0, resetAt: 0 }, day: { n: 0, resetAt: 0 } }; _buckets.set(req.userId, b); }
    if (now > b.min.resetAt) { b.min.n = 0; b.min.resetAt = now + 60_000; }
    if (now > b.day.resetAt) { b.day.n = 0; b.day.resetAt = now + 864e5; }

    const over = (b.min.n >= perMin && "minute") || (perDay && b.day.n >= perDay && "day") || null;
    if (over) {
      const retry = Math.ceil(((over === "minute" ? b.min.resetAt : b.day.resetAt) - now) / 1000);
      audit(req, "rate_limited", `${action}: ${over} limit`, 429);
      console.warn("rate limited", { userId: req.userId, window: over });
      return res.status(429).set("Retry-After", String(retry))
        .json({ error: `Too many Salesforce requests — try again in ${retry > 90 ? Math.ceil(retry / 60) + " minutes" : retry + " seconds"}.` });
    }
    b.min.n++; b.day.n++;
    next();
  };
}

// Buckets for users who have gone quiet would otherwise accumulate for the life of the
// process. Drop anything whose daily window has long expired.
setInterval(() => {
  const cutoff = Date.now() - 864e5;
  for (const [k, b] of _buckets) if (b.day.resetAt < cutoff) _buckets.delete(k);
}, 60 * 60 * 1000).unref();

// --- Identity bridge: verify the Supabase JWT → req.userId ---
//
// The JWT is genuinely verified (getUser hits GoTrue, which checks signature + expiry) —
// nothing here trusts a decoded token, and no route accepts a user id from the request.
//
// AUTHORIZATION is separate and opt-in: set SF_ALLOWED_ROLES to a comma-separated list of
// user_profiles.role values that may use Salesforce, e.g. "super_admin,admin". Until it is
// set, every authenticated app user passes — including 'viewer' and anyone whose account
// was never deprovisioned — because the app's tile permissions are enforced client-side
// and never reach this service. Left opt-in so deploying this can't lock out a live
// integration; set it as soon as you know which roles should qualify.
const SF_ROLES = (process.env.SF_ALLOWED_ROLES || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!SF_ROLES.length) {
  console.warn("[security] SF_ALLOWED_ROLES is not set — ANY authenticated app user can use the Salesforce proxy. Set it to e.g. super_admin,admin");
}

// Session only: a valid app login, no Salesforce role required. Split out of requireUser
// so the opportunity-summary route can serve users who deliberately have NO Salesforce
// access — gating that route on SF_ALLOWED_ROLES would lock out exactly the people it
// exists for. Everything else still goes through requireUser.
async function requireSession(req, res, next) {
  const h = req.headers.authorization || "";
  const jwt = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: "No auth token" });
  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data?.user) return res.status(401).json({ error: "Invalid session" });
  req.userId = data.user.id;
  next();
}

async function requireUser(req, res, next) {
  const h = req.headers.authorization || "";
  const jwt = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: "No auth token" });
  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data?.user) return res.status(401).json({ error: "Invalid session" });
  req.userId = data.user.id;
  if (SF_ROLES.length) {
    const { data: prof, error: pErr } = await supabaseAdmin
      .from("user_profiles").select("role").eq("id", req.userId).maybeSingle();
    if (pErr) { console.error("role lookup failed:", pErr.message); return res.status(503).json({ error: "Could not check permissions" }); }
    const role = (prof && prof.role) || "";
    if (!SF_ROLES.includes(role)) {
      audit(req, "role_denied", `role=${role || "(none)"}`, 403);
      return res.status(403).json({ error: "Your role does not have Salesforce access" });
    }
    req.userRole = role;
  }
  next();
}

// --- Step 1: start login (build PKCE + state, stash pending, return the Salesforce authorize URL) ---
// Rate limited harder than the proxy: starting a handshake writes a row and there is no
// legitimate reason to do it more than a few times a minute.
app.post("/api/oauth/start", requireUser, rateLimit({ perMin: 6, perDay: 0, action: "oauth_start" }), async (req, res) => {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64url(crypto.randomBytes(24));

  // Lightweight cleanup of stale handshakes (older than the TTL), then stash this one.
  await supabaseAdmin.from("sf_oauth_pending").delete().lt("created_at", new Date(Date.now() - PENDING_TTL_MS).toISOString());
  const { error } = await supabaseAdmin.from("sf_oauth_pending").insert({ state, user_id: req.userId, code_verifier: verifier });
  if (error) { console.error("pending insert failed:", error); return res.status(500).json({ error: "Could not start login" }); }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SF_CLIENT_ID,
    redirect_uri: process.env.SF_CALLBACK_URL,
    scope: "api refresh_token",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  audit(req, "oauth_start", null, 200);
  res.json({ authorizeUrl: `${process.env.SF_LOGIN_URL}/services/oauth2/authorize?${params}` });
});

// --- Step 2: callback (browser redirect from Salesforce; identity comes from the pending row) ---
app.get("/api/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  // Query params can arrive as arrays (?state[]=x) — a non-string would reach PostgREST
  // and blow up unhandled.
  if (typeof code !== "string" || typeof state !== "string" || !code || !state) return res.status(400).send("Missing code/state");

  const { data: pending } = await supabaseAdmin.from("sf_oauth_pending").select("*").eq("state", state).maybeSingle();
  if (!pending) return res.status(400).send("Invalid or expired login — please try again");
  // The pending row (state + PKCE verifier) is consumed EXACTLY ONCE — the delete is in a
  // finally, so a failed token exchange can't leave a replayable handshake alive for the
  // rest of the TTL.
  try {
    if (Date.now() - new Date(pending.created_at).getTime() > PENDING_TTL_MS) {
      return res.status(400).send("Login expired — please try again");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
      redirect_uri: process.env.SF_CALLBACK_URL,
      code_verifier: pending.code_verifier,
    });
    const r = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
      signal: AbortSignal.timeout(SF_TIMEOUT_MS),
    });
    if (!r.ok) { console.error("token exchange failed with status", r.status); return res.status(502).send("Token exchange failed"); }
    const t = await r.json();
    if (!t.refresh_token) { console.error("no refresh_token returned — check the connected app's refresh_token scope/policy"); return res.status(502).send("No refresh token returned by Salesforce"); }

    // Best-effort: resolve the Salesforce username so /api/auth/status can show
    // "Connected as …" (it selects sf_username, which nothing used to write).
    let sfUsername = null;
    if (t.id) {
      try {
        const who = await fetch(t.id, { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(8000) });
        if (who.ok) { const j = await who.json(); sfUsername = j.username || j.preferred_username || null; }
      } catch { /* the connection is still fine without a display name */ }
    }

    await supabaseAdmin.from("salesforce_tokens").upsert({
      user_id: pending.user_id,
      access_token: seal(t.access_token, pending.user_id),
      refresh_token: seal(t.refresh_token, pending.user_id),
      instance_url: t.instance_url,
      ...(sfUsername ? { sf_username: sfUsername } : {}),
      updated_at: new Date().toISOString(),
    });

    // No req.userId here — the callback is an unauthenticated browser redirect, identified
    // by the pending row instead.
    audit({ userId: pending.user_id, headers: req.headers }, "connected", sfUsername, 200);
    res.redirect(process.env.APP_REDIRECT_URL || "http://localhost:5173/budget-calc");
  } finally {
    await supabaseAdmin.from("sf_oauth_pending").delete().eq("state", state);
  }
});

// --- Refresh helper (handles rotation), persists the rotated tokens ---
// `row` must already be decrypted (openRow); what goes back to the database is re-sealed.
async function refreshSalesforce(userId, row) {
  if (!row.refresh_token) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
  });
  const r = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!r.ok) { console.error("refresh failed:", await r.text()); return null; }
  const t = await r.json();
  const updated = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || row.refresh_token,   // SF may rotate the refresh token
    instance_url: t.instance_url || row.instance_url,
    updated_at: new Date().toISOString(),
  };
  await supabaseAdmin.from("salesforce_tokens").update({
    ...updated,
    access_token: seal(updated.access_token, userId),
    refresh_token: seal(updated.refresh_token, userId),
  }).eq("user_id", userId);
  return updated;   // callers get the plaintext they need to make the call
}

// --- Auth status for the frontend ---
app.get("/api/auth/status", requireUser, async (req, res) => {
  const { data } = await supabaseAdmin.from("salesforce_tokens").select("user_id, sf_username").eq("user_id", req.userId).maybeSingle();
  res.json({ authenticated: Boolean(data), username: data?.sf_username || null });
});

// --- Disconnect: revoke at Salesforce, then forget the tokens ---
//
// There was previously no way to disconnect at all. A refresh token is long-lived and does
// not expire on its own, so every connection ever made stayed usable indefinitely —
// including one belonging to someone who has since left, whose app account being disabled
// does nothing to the Salesforce grant sitting in this table.
//
// Revoking the refresh token at Salesforce also invalidates the access tokens issued from
// it, so this kills the grant at the source rather than only locally.
//
// A super admin may pass { userId } to disconnect someone else — the offboarding case, and
// the one that actually matters: disabling a leaver's app account does nothing to the
// Salesforce grant sitting in this table, and they cannot call this route for themselves
// once they are locked out. Anyone else may only disconnect their own connection.
app.post("/api/oauth/disconnect", requireUser, rateLimit({ perMin: 6, perDay: 0, action: "disconnect" }), async (req, res) => {
  let target = req.userId;
  const asked = req.body && req.body.userId;
  if (asked && asked !== req.userId) {
    const { data: prof } = await supabaseAdmin.from("user_profiles").select("role").eq("id", req.userId).maybeSingle();
    if (!prof || prof.role !== "super_admin") {
      audit(req, "disconnect_denied", `tried to disconnect ${asked}`, 403);
      return res.status(403).json({ error: "Only a super admin can disconnect another user" });
    }
    if (!/^[0-9a-f-]{36}$/i.test(String(asked))) return res.status(400).json({ error: "Bad userId" });
    target = String(asked);
  }

  const { data: raw } = await supabaseAdmin.from("salesforce_tokens").select("*").eq("user_id", target).maybeSingle();
  if (!raw) return res.json({ disconnected: true, revoked: false });   // already gone; not an error

  const row = openRow(raw, target);
  let revoked = false;
  if (row?.refresh_token) {
    // Try the user's own instance first (the authoritative host for their org), then the
    // login host.
    for (const host of [row.instance_url, process.env.SF_LOGIN_URL].filter(Boolean)) {
      try {
        const r = await fetch(`${host}/services/oauth2/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: row.refresh_token }),
          signal: AbortSignal.timeout(SF_TIMEOUT_MS),
        });
        if (r.ok) { revoked = true; break; }
      } catch { /* try the next host */ }
    }
    if (!revoked) console.error("salesforce revoke failed for user", target);
  }

  // Delete regardless. If revocation failed we must still stop holding the credential —
  // leaving the row because Salesforce was unreachable would be the worse outcome, and it
  // is recorded below so a failed revoke can be chased manually.
  const { error } = await supabaseAdmin.from("salesforce_tokens").delete().eq("user_id", target);
  if (error) { console.error("token delete failed:", error.message); return res.status(500).json({ error: "Could not disconnect" }); }
  audit(req, "disconnected", `${target === req.userId ? "self" : "by admin: " + target} — ${revoked ? "revoked at Salesforce" : "local only, REVOKE FAILED"}`, 200);
  res.json({ disconnected: true, revoked });
});

// --- Authenticated READ-ONLY proxy to the Salesforce REST API ---
//
// This used to be app.all() with no path or method restriction, i.e. a generic
// passthrough. Any user with a connected Salesforce account (or anyone holding their
// Supabase token) could therefore issue arbitrary Salesforce REST calls as themselves —
// DELETE/PATCH on /sobjects/..., composite/batch, Bulk, Tooling, Apex REST — with
// Salesforce-side profile permissions as the only remaining control and no audit trail
// here. The app only ever needs GET on the query endpoint (see sfFetch in
// src/salesforce.jsx), so:
//   • GET only — no method can mutate Salesforce through this service any more
//   • path must be under services/data/vNN.N/ (blocks Bulk/Tooling/Apex/UI endpoints)
//   • no ".." or leading "/" (path traversal off the API root)
//   • request bodies are never forwarded
//   • URL length capped so a runaway SOQL can't be used as an amplifier
// To allow a write later, add an explicit narrow route for it rather than reopening this.
const SF_PATH_OK = /^services\/data\/v\d{2}\.\d\/[A-Za-z0-9_\-/]+(\?.*)?$/;
const SF_MAX_URL = 8000;
const SF_TIMEOUT_MS = 20000;
const SF_MAX_BYTES = 25 * 1024 * 1024;

// ── Opportunity summary: the budget's discrepancy card, for EVERY app user ──────────
//
// The card compares a budget against its Salesforce opportunity. Every other route here
// runs as the CALLER, so a user who has never linked their own Salesforce got a 401 and
// the card vanished (Jed 2026-08-31: it should show for all estimating/budget users).
//
// This route answers from the caller's own connection when they have one — preserving
// their field-level security — and otherwise from a SERVICE ACCOUNT held here.
//
// It is deliberately NOT a service-account fallback on the generic proxy below: that one
// forwards arbitrary SOQL, so falling IT back would let any app user run any query they
// liked as the service identity. This route builds its own query and can only ever return
// one opportunity's name, number, Amount and budgeted GP.
//
// The mapped field names arrive from the client, so they are validated as bare API names
// before being interpolated — an unvalidated field param is a SOQL injection hole. That
// validation and the query building live in oppSummary.js, where they are unit-tested.

let svcTok = null;   // { access_token, instance_url, at } — in-memory only, never persisted
// ── the service grant's refresh token ROTATES, so it cannot live in an env var ──
//
// The org enforces "Enable Refresh Token Rotation" on the External Client App and Salesforce
// Support is required to turn it off (Jed found the setting, 2026-09-03). Rotation means every
// refresh mints a NEW refresh token and invalidates the one just used — and running code cannot
// write back to Render's environment. So the old version worked exactly once: the first refresh
// rotated the grant, the env var went stale, and every refresh after that failed invalid_grant.
// Which is precisely what Casey and Chad hit on a token that was a week old and in daily use.
//
// Same shape as myobToken.js, for the same reason and against the same table: the rotated token is
// written to integration_tokens on every refresh, and SF_SERVICE_REFRESH_TOKEN is demoted to a
// BOOTSTRAP — used only until the first stored row exists.
//
// rotated_count is the honest health signal: if it stops climbing while people are reading
// Salesforce, refresh has stopped working and the grant is drifting toward its 30-day idle expiry
// (also enforced, also Support-only).
// The last refresh failure, for /api/salesforce/service-status. Recorded rather than re-derived
// because a diagnostic MUST NOT perform its own refresh: with rotation on, that would mint a new
// refresh token, invalidate the live one, and throw the new one away — the check would break the
// thing it is checking. (My first version of that endpoint did exactly this.)
let svcLastErr = null;
const SF_SVC_PROVIDER = "salesforce_service";
const SF_SVC_SEAL_ID = "salesforce_service";

async function sfServiceRefreshToken() {
  const { data, error } = await supabaseAdmin
    .from("integration_tokens").select("refresh_token, rotated_count, meta")
    .eq("provider", SF_SVC_PROVIDER).maybeSingle();
  if (error) { console.error("integration_tokens read failed:", error.message); return null; }
  if (data && data.refresh_token) {
    // A row written before TOKEN_ENC_KEY was set is plaintext — unseal only what is sealed, so
    // enabling encryption later does not strand the row.
    const plain = isSealed(data.refresh_token)
      ? unseal(data.refresh_token, SF_SVC_SEAL_ID) : data.refresh_token;
    if (!plain) { console.error("stored Salesforce service token could not be decrypted — TOKEN_ENC_KEY may have changed"); return null; }
    return { refresh: plain, rotations: data.rotated_count || 0, instance: (data.meta && data.meta.instance) || "", seeded: false };
  }
  const boot = process.env.SF_SERVICE_REFRESH_TOKEN;
  if (!boot) return null;
  return { refresh: boot, rotations: 0, instance: process.env.SF_SERVICE_INSTANCE_URL || "", seeded: true };
}

async function sfServiceStore(refresh, rotations, instance, note) {
  const value = ENC_KEY ? seal(refresh, SF_SVC_SEAL_ID) : refresh;
  const { error } = await supabaseAdmin.from("integration_tokens").upsert({
    provider: SF_SVC_PROVIDER,
    refresh_token: value,
    rotated_count: rotations,
    meta: { instance, note },
    updated_at: new Date().toISOString(),
    updated_by: "sfServiceToken",
  });
  // A failed WRITE is the dangerous case: the refresh already happened, so the token we hold is
  // now the only valid one and it is only in memory. Say so loudly — the next cold start loses it.
  if (error) console.error("[salesforce] could not persist the rotated service refresh token:", error.message,
    "— the grant will need re-issuing after the next restart");
}

async function serviceToken(force) {
  if (!force && svcTok && Date.now() - svcTok.at < 30 * 60 * 1000) return svcTok;
  const held = await sfServiceRefreshToken();
  if (!held) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: held.refresh,
    client_id: process.env.SF_SERVICE_CLIENT_ID || process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_SERVICE_CLIENT_SECRET || process.env.SF_CLIENT_SECRET,
  });
  const r = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    signal: AbortSignal.timeout(SF_TIMEOUT_MS),
  });
  if (!r.ok) {
    const raw = await r.text();
    let parsed = null; try { parsed = JSON.parse(raw); } catch { /* not json */ }
    svcLastErr = {
      status: r.status,
      error: (parsed && parsed.error) || null,
      description: (parsed && parsed.error_description) || null,
      seeded: held.seeded, rotations: held.rotations, at: Date.now(),
    };
    console.error("service-account refresh failed:", r.status, raw,
      held.seeded ? "(using the SF_SERVICE_REFRESH_TOKEN bootstrap)" : `(using the stored token, ${held.rotations} rotations)`);
    svcTok = null; return null;
  }
  const t = await r.json();
  const instance = t.instance_url || held.instance || process.env.SF_SERVICE_INSTANCE_URL || "";
  // Persist BEFORE returning, and whether or not Salesforce rotated: t.refresh_token is absent
  // when it did not, in which case the one we hold is still the live one and re-storing it is a
  // harmless no-op that also seeds the row on the bootstrap run.
  const next = t.refresh_token || held.refresh;
  await sfServiceStore(next, held.rotations + (t.refresh_token && t.refresh_token !== held.refresh ? 1 : 0), instance,
    held.seeded ? "seeded from SF_SERVICE_REFRESH_TOKEN" : "rotated on refresh");
  svcLastErr = null;
  svcTok = { access_token: t.access_token, instance_url: instance, at: Date.now() };
  return svcTok.instance_url ? svcTok : null;
}

// Is the SERVICE ACCOUNT working? Read-only, no secrets in the response.
//
// Added 2026-09-03: Casey (admin, no Salesforce connection of his own) saw "Couldn't reach
// Salesforce" on the discrepancy register. The service-account fallback below is exactly what is
// meant to serve him, and every environment variable it needs is present, so the failure is at
// run time — and the only record of WHY was a console line in Render. DevTools is blocked on Jed's
// machine, so a URL he can open is the practical instrument. Same reasoning as logging the
// takeoff's hub-link attempts to a table instead of the console.
//
// It reports the three outcomes serviceToken() collapses into one null:
//
//   configured:false            SF_SERVICE_REFRESH_TOKEN is not set
//   ok:false + status/error     Salesforce refused the refresh (invalid_grant, bad client, …)
//   ok:false + noInstanceUrl    the refresh SUCCEEDED but returned no instance_url and
//                               SF_SERVICE_INSTANCE_URL is unset — serviceToken returns null here
//                               and logs NOTHING, so this case was invisible
//   ok:true                     a token was obtained; whoami says which Salesforce identity it is
//
// requireSession, not requireUser: the point is that a user with NO Salesforce access can
// self-diagnose, and gating it on SF_ALLOWED_ROLES would exclude exactly them. Nothing here is
// secret — an HTTP status, Salesforce's own error code, and the identity the grant belongs to.
app.get("/api/salesforce/service-status", requireSession, async (req, res) => {
  // Goes through serviceToken(), the SAME path the summary route uses, so it reports on the token
  // that actually serves users — and so the rotated token it produces is PERSISTED. An endpoint
  // that refreshed on its own would invalidate the live grant every time someone checked.
  const stored = await sfServiceRefreshToken();
  if (!stored) {
    return res.json({ configured: false, ok: false,
      detail: "No service refresh token is stored and SF_SERVICE_REFRESH_TOKEN is unset — run authorize-service.js and set it once to seed the store." });
  }
  const tok = await serviceToken(false);
  if (tok) {
    let who = null;
    try {
      const wr = await fetch(`${tok.instance_url}/services/oauth2/userinfo`, {
        headers: { Authorization: `Bearer ${tok.access_token}` },
        signal: AbortSignal.timeout(SF_TIMEOUT_MS),
      });
      if (wr.ok) { const u = await wr.json(); who = (u && (u.preferred_username || u.email || u.name)) || null; }
    } catch { /* the token is the point; the identity is a nicety */ }
    const { data } = await supabaseAdmin.from("integration_tokens")
      .select("rotated_count, updated_at").eq("provider", SF_SVC_PROVIDER).maybeSingle();
    return res.json({ configured: true, ok: true, identity: who, instance: tok.instance_url,
      seeded: stored.seeded,
      rotations: (data && data.rotated_count) || 0,
      lastRotated: (data && data.updated_at) || null,
      detail: "The service account can obtain a token, so every user should be able to read opportunity summaries. If one cannot, the failure is on the query rather than the connection." });
  }
  const e = svcLastErr || {};
  res.json({ configured: true, ok: false,
    status: e.status || null, error: e.error || null, description: e.description || null,
    seeded: stored.seeded, rotations: stored.rotations,
    detail: e.error === "invalid_grant"
      ? "Salesforce rejected the stored refresh token. With refresh-token rotation enforced on the External Client App, this means the stored token is no longer the current one — re-issue with authorize-service.js and set SF_SERVICE_REFRESH_TOKEN once to reseed. If it recurs, the rotated token is not being persisted; check the logs for 'could not persist the rotated service refresh token'."
      : "Salesforce refused the service-account refresh. See status/error above; the backend logs carry the full response." });
});

app.get("/api/salesforce/opportunity-summary", requireSession, rateLimit({ perMin: RATE_PER_MIN, perDay: RATE_PER_DAY, action: "opp_summary" }), async (req, res) => {
  const id = String(req.query.id || "").trim();
  const gpField = String(req.query.gpField || "").trim();
  const numberField = String(req.query.numberField || "").trim();
  const q = buildSummaryQuery(id, gpField, numberField);
  if (!q) return res.status(400).json({ error: "Bad opportunity id" });
  const extra = q.extra;
  const path = `services/data/v60.0/query?q=${encodeURIComponent(q.soql)}`;
  const minimal = `services/data/v60.0/query?q=${encodeURIComponent(q.minimalSoql)}`;

  // caller's own connection first — their field-level security is the right one to apply
  let token = null, instance = null, viaService = false;
  const { data: raw } = await supabaseAdmin.from("salesforce_tokens").select("*").eq("user_id", req.userId).maybeSingle();
  const row = raw ? openRow(raw, req.userId) : null;
  if (row) { token = row.access_token; instance = row.instance_url; }

  const call = (p, tk, inst) => fetch(`${inst}/${p}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(SF_TIMEOUT_MS),
  });

  try {
    let r = token ? await call(path, token, instance) : null;
    if (r && r.status === 401) {                       // their token expired — refresh once
      const refreshed = await refreshSalesforce(req.userId, row);
      r = refreshed ? await call(path, refreshed.access_token, refreshed.instance_url) : null;
      if (refreshed) { token = refreshed.access_token; instance = refreshed.instance_url; }
    }
    if (!r || !r.ok) {                                 // no connection, or theirs can't answer
      const svc = await serviceToken(false);
      if (!svc) {
        audit(req, "opp_summary_unavailable", id, 503);
        return res.status(503).json({ error: "No Salesforce connection available for this request" });
      }
      viaService = true;
      r = await call(path, svc.access_token, svc.instance_url);
      if (r.status === 401) {                          // cached service token stale — force one refresh
        const fresh = await serviceToken(true);
        if (!fresh) return res.status(503).json({ error: "Salesforce service account unavailable" });
        r = await call(path, fresh.access_token, fresh.instance_url);
      }
      instance = svc.instance_url; token = svc.access_token;
    }
    // one mapped field the identity can't see fails the whole query — drop the extras and
    // retry bare, so a bad GP mapping costs the GP column rather than the whole card
    if (!r.ok && extra.length) r = await call(minimal, token, instance);
    if (!r.ok) {
      const msg = await r.text();
      console.warn("opportunity-summary upstream:", r.status, msg.slice(0, 300));
      audit(req, "opp_summary_failed", `${id} — ${r.status}`, r.status);
      return res.status(r.status === 404 ? 404 : 502).json({ error: "Salesforce could not answer" });
    }
    const data = await r.json();
    const rec = (data.records || [])[0];
    if (!rec) { audit(req, "opp_summary", `${id} — not found`, 404); return res.status(404).json({ error: "Opportunity not found" }); }
    audit(req, "opp_summary", `${id}${viaService ? " (service)" : ""}`, 200);
    res.json(shapeSummary(rec, { id, gpField, numberField, viaService }));
  } catch (e) {
    console.error("opportunity-summary error:", e && e.name, e && e.message);
    audit(req, "opp_summary_error", `${id} — ${e && e.name}`, 502);
    res.status(502).json({ error: "Salesforce request failed" });
  }
});

app.get("/api/salesforce/*splat", requireUser, rateLimit({ perMin: RATE_PER_MIN, perDay: RATE_PER_DAY, action: "proxy" }), async (req, res) => {
  const sfPath = req.originalUrl.replace(/^\/api\/salesforce\//i, "");   // strip prefix, keep path + query
  if (sfPath.length > SF_MAX_URL) return res.status(414).json({ error: "Request too long" });
  if (sfPath.startsWith("/") || sfPath.includes("..") || /%2e%2e/i.test(sfPath) || !SF_PATH_OK.test(sfPath)) {
    console.warn("blocked salesforce path", { userId: req.userId, method: req.method });
    audit(req, "proxy_blocked", sfPath, 403);
    return res.status(403).json({ error: "That Salesforce endpoint is not allowed through this proxy" });
  }

  const { data: raw } = await supabaseAdmin.from("salesforce_tokens").select("*").eq("user_id", req.userId).maybeSingle();
  if (!raw) return res.status(401).json({ error: "Not connected to Salesforce" });
  const row = openRow(raw, req.userId);
  if (!row) return res.status(401).json({ error: "Stored Salesforce credentials could not be read — reconnect" });

  const doFetch = (token, instanceUrl) => fetch(`${instanceUrl}/${sfPath}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(SF_TIMEOUT_MS),
  });

  try {
    let r = await doFetch(row.access_token, row.instance_url);
    if (r.status === 401) {
      const refreshed = await refreshSalesforce(req.userId, row);
      if (!refreshed) return res.status(401).json({ error: "Salesforce session expired — reconnect" });
      r = await doFetch(refreshed.access_token, refreshed.instance_url);
    }
    const len = Number(r.headers.get("content-length") || 0);
    if (len > SF_MAX_BYTES) return res.status(502).json({ error: "Salesforce response too large" });
    const data = await r.text();
    if (data.length > SF_MAX_BYTES) return res.status(502).json({ error: "Salesforce response too large" });
    audit(req, "proxy", sfPath, r.status);
    // pass the upstream content type through rather than asserting JSON — an HTML error
    // page mislabelled as JSON just confuses the caller
    res.status(r.status).type(r.headers.get("content-type") || "application/json").send(data);
  } catch (e) {
    console.error("salesforce proxy error:", e && e.name, e && e.message);
    audit(req, "proxy_error", `${sfPath} — ${e && e.name}`, 502);
    res.status(502).json({ error: "Salesforce request failed" });
  }
});

// Terminal error handler. Without one, Express 5 hands async rejections to finalhandler,
// which includes err.stack in the RESPONSE unless NODE_ENV is exactly "production" —
// don't rely on an env var to avoid leaking internals.
app.use((err, _req, res, _next) => {
  console.error("unhandled:", err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal error" });
});

// One-off sweep: encrypt any row still holding plaintext.
//
// Reading a row re-encrypts it (openRow), but that only ever reaches accounts that are
// actually being used. A token belonging to someone who hasn't touched Salesforce since
// the key was introduced would sit in plaintext indefinitely — which is exactly what
// encryption at rest is supposed to prevent. Lazy migration is the right behaviour on the
// hot path; it is not a migration strategy on its own.
//
// Runs after the listener so a slow or failing sweep can never stop the service booting.
async function encryptTokensAtRest() {
  if (!ENC_KEY) return;
  const { data, error } = await supabaseAdmin
    .from("salesforce_tokens").select("user_id, access_token, refresh_token");
  if (error) { console.error("[security] token sweep failed:", error.message); return; }

  let done = 0, skipped = 0;
  for (const row of data || []) {
    if (isSealed(row.access_token) && isSealed(row.refresh_token)) continue;
    const access = unseal(row.access_token, row.user_id);
    const refresh = unseal(row.refresh_token, row.user_id);
    // Never overwrite a row we couldn't read — that would replace an unreadable token with
    // a re-sealed null and destroy any chance of recovering it.
    if (access == null || refresh == null) { skipped++; continue; }
    const { error: e } = await supabaseAdmin.from("salesforce_tokens").update({
      access_token: seal(access, row.user_id),
      refresh_token: seal(refresh, row.user_id),
    }).eq("user_id", row.user_id);
    if (e) { console.error("[security] could not encrypt token for", row.user_id, e.message); skipped++; }
    else done++;
  }
  if (done) console.log(`[security] encrypted ${done} stored Salesforce token(s) at rest`);
  if (skipped) console.error(`[security] ${skipped} token(s) could NOT be encrypted — check the logs above`);
}

/* ── THE NIGHTLY MYOB ACTUALS SYNC ────────────────────────────────────────────────────────────
 *
 * OFF unless MYOB_SYNC_SCHEDULE=1. Deploying this must not start making requests against a live
 * ERP by surprise, and a Render Cron Job — which is the tidier arrangement, being isolated from
 * the web service and having its own run history — must be usable without both firing.
 *
 * NOT A CRON EXPRESSION. It checks hourly and syncs when the DATA is older than 20 hours, so a
 * missed window is caught on the next tick instead of waited out for a day, and a deploy at 03:00
 * does not skip. The "have we already run" decision is read from max(synced_at) inside
 * syncActuals, not held here: this timer re-arms on every restart and exists once per instance, so
 * its own memory is worth nothing. Two instances both tick, both ask the database, and the second
 * finds a fresh stamp and stops before opening a session.
 *
 * WHY THAT MATTERS MORE THAN A WASTED REQUEST: a Basic-auth request creates an Acumatica session,
 * and the licence counts sessions, not requests. Syncing twice is a step towards locking real
 * people out of MYOB.
 *
 * The sync never throws into the timer — a failure is logged loudly and the next tick tries again.
 * Nothing is written on failure and the sweep cannot run, so a bad night leaves yesterday's
 * figures in place, which the Integrations panel then reports as stale. */
function startActualsSchedule() {
  if (!schedulerEnabled()) {
    console.log("[myob] actuals schedule OFF (set MYOB_SYNC_SCHEDULE=1 to enable, or use a Render Cron Job)");
    return;
  }
  const tick = async () => {
    try {
      const out = await syncActuals(supabaseAdmin, { guard: true });
      if (out.skipped) console.log(`[myob] actuals sync skipped — ${out.reason}`);
      else console.log(`[myob] actuals synced: ${out.written} figure(s) from ${out.read} ledger row(s)`
        + `, swept ${out.swept}, as ${out.as}`);
    } catch (e) {
      /* Named loudly and with the status, because the failure this most needs to survive is the
         MYOB password changing on the account it borrows — and the whole point of the health panel
         is that such a failure is not silent for days, the way the Salesforce one was. */
      console.error(`[myob] actuals sync FAILED${e && e.status ? ` (HTTP ${e.status})` : ""}: ${(e && e.message) || e}`);
    }
  };
  const jitter = startupJitterMs();
  console.log(`[myob] actuals schedule ON — first check in ${Math.round(jitter / 60000)} min, then hourly`);
  /* unref so this timer can never hold the process open during a shutdown. */
  setTimeout(() => { tick(); setInterval(tick, CHECK_MS).unref(); }, jitter).unref();
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on :${PORT}`);
  encryptTokensAtRest().catch((e) => console.error("[security] token sweep threw:", e && e.message));
  startActualsSchedule();
});
