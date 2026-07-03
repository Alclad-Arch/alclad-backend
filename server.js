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
//   NODE_ENV=production
//   For LOCAL dev: SF_CALLBACK_URL=http://localhost:3001/api/oauth/callback (register it in the SF app too).

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();

// Service-role Supabase client — bypasses RLS, so it's the only thing that can read/write the
// backend-only tables. Held server-side; never exposed to the frontend.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const ALLOWED = (process.env.ALLOWED_ORIGINS || "https://alclad.app,http://localhost:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: ALLOWED,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
}));
app.use(express.json());

const base64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const PENDING_TTL_MS = 10 * 60 * 1000;   // OAuth handshake window

// --- Identity bridge: verify the Supabase JWT → req.userId ---
async function requireUser(req, res, next) {
  const h = req.headers.authorization || "";
  const jwt = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: "No auth token" });
  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data?.user) return res.status(401).json({ error: "Invalid session" });
  req.userId = data.user.id;
  next();
}

// --- Step 1: start login (build PKCE + state, stash pending, return the Salesforce authorize URL) ---
app.post("/api/oauth/start", requireUser, async (req, res) => {
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
  res.json({ authorizeUrl: `${process.env.SF_LOGIN_URL}/services/oauth2/authorize?${params}` });
});

// --- Step 2: callback (browser redirect from Salesforce; identity comes from the pending row) ---
app.get("/api/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("Missing code/state");

  const { data: pending } = await supabaseAdmin.from("sf_oauth_pending").select("*").eq("state", state).maybeSingle();
  if (!pending) return res.status(400).send("Invalid or expired login — please try again");
  if (Date.now() - new Date(pending.created_at).getTime() > PENDING_TTL_MS) {
    await supabaseAdmin.from("sf_oauth_pending").delete().eq("state", state);
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
  });
  if (!r.ok) { console.error("token exchange failed:", await r.text()); return res.status(502).send("Token exchange failed"); }
  const t = await r.json();
  if (!t.refresh_token) { console.error("no refresh_token returned — check the connected app's refresh_token scope/policy"); return res.status(502).send("No refresh token returned by Salesforce"); }

  await supabaseAdmin.from("salesforce_tokens").upsert({
    user_id: pending.user_id,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    instance_url: t.instance_url,
    updated_at: new Date().toISOString(),
  });
  await supabaseAdmin.from("sf_oauth_pending").delete().eq("state", state);

  res.redirect(process.env.APP_REDIRECT_URL || "http://localhost:5173/budget-calc");
});

// --- Refresh helper (handles rotation), persists the rotated tokens ---
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
  await supabaseAdmin.from("salesforce_tokens").update(updated).eq("user_id", userId);
  return updated;
}

// --- Auth status for the frontend ---
app.get("/api/auth/status", requireUser, async (req, res) => {
  const { data } = await supabaseAdmin.from("salesforce_tokens").select("user_id, sf_username").eq("user_id", req.userId).maybeSingle();
  res.json({ authenticated: Boolean(data), username: data?.sf_username || null });
});

// --- Authenticated proxy to the Salesforce REST API (per-user tokens, auto-refresh on 401) ---
app.all("/api/salesforce/*splat", requireUser, async (req, res) => {
  const { data: row } = await supabaseAdmin.from("salesforce_tokens").select("*").eq("user_id", req.userId).maybeSingle();
  if (!row) return res.status(401).json({ error: "Not connected to Salesforce" });

  const sfPath = req.originalUrl.replace(/^\/api\/salesforce\//, "");   // strip prefix, keep path + query
  const doFetch = (token, instanceUrl) => fetch(`${instanceUrl}/${sfPath}`, {
    method: req.method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
  });

  try {
    let r = await doFetch(row.access_token, row.instance_url);
    if (r.status === 401) {
      const refreshed = await refreshSalesforce(req.userId, row);
      if (!refreshed) return res.status(401).json({ error: "Salesforce session expired — reconnect" });
      r = await doFetch(refreshed.access_token, refreshed.instance_url);
    }
    const data = await r.text();
    res.status(r.status).type("application/json").send(data);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "Salesforce request failed" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
