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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
