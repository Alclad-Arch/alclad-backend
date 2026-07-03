// server.js — Salesforce OAuth backend proxy for the Alclad React app
//
// Setup:
//   1. npm install express express-session dotenv
//   2. Make sure package.json has  "type": "module"
//   3. Create a .env file (see the block at the bottom of this comment)
//   4. node server.js
//
// .env template:
//   SF_CLIENT_ID=your_consumer_key
//   SF_CLIENT_SECRET=your_consumer_secret
//   SF_CALLBACK_URL=https://alclad.app/api/oauth/callback
//   SF_LOGIN_URL=https://login.salesforce.com
//   SESSION_SECRET=a_long_random_string
//   NODE_ENV=development
//
// For LOCAL testing, set instead:
//   SF_CALLBACK_URL=http://localhost:3001/api/oauth/callback
//   (and register that URL in the External Client App too)

import "dotenv/config";
import express from "express";
import session from "express-session";
import crypto from "crypto";

const app = express();
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // false on localhost (http)
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

// --- PKCE helper ---
const base64url = (buf) =>
  buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// --- Step 1: start login (build PKCE, redirect to Salesforce) ---
app.get("/api/oauth/login", (req, res) => {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash("sha256").update(verifier).digest()
  );
  const state = base64url(crypto.randomBytes(16));

  req.session.pkceVerifier = verifier;
  req.session.oauthState = state;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SF_CLIENT_ID,
    redirect_uri: process.env.SF_CALLBACK_URL,
    scope: "api refresh_token",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  res.redirect(
    `${process.env.SF_LOGIN_URL}/services/oauth2/authorize?${params}`
  );
});

// --- Step 2: callback (exchange code for tokens) ---
app.get("/api/oauth/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || state !== req.session.oauthState) {
    return res.status(400).send("Invalid OAuth state");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
    redirect_uri: process.env.SF_CALLBACK_URL,
    code_verifier: req.session.pkceVerifier,
  });

  const r = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!r.ok) {
    console.error("Token exchange failed:", await r.text());
    return res.status(502).send("Token exchange failed");
  }

  const tokens = await r.json();

  req.session.sf = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    instanceUrl: tokens.instance_url,
  };
  delete req.session.pkceVerifier;
  delete req.session.oauthState;

  // Back to the React app, now authenticated. In prod set APP_REDIRECT_URL to the deployed app URL
  // (e.g. https://alclad.app/budget-calc); falls back to the local dev server.
  res.redirect(process.env.APP_REDIRECT_URL || "http://localhost:5173/sftest");
});

// --- Step 3: refresh helper (handles rotation) ---
async function refreshSalesforce(req) {
  const { refreshToken } = req.session.sf || {};
  if (!refreshToken) throw new Error("No refresh token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
  });

  const r = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!r.ok) throw new Error("Refresh failed: " + (await r.text()));

  const t = await r.json();
  req.session.sf.accessToken = t.access_token;
  if (t.refresh_token) req.session.sf.refreshToken = t.refresh_token; // rotation
  if (t.instance_url) req.session.sf.instanceUrl = t.instance_url;
  return req.session.sf.accessToken;
}

// --- Step 4: the API proxy ---
app.all("/api/salesforce/*splat", async (req, res) => {
  const sf = req.session.sf;
  if (!sf) return res.status(401).json({ error: "Not authenticated" });

  // strip the /api/salesforce/ prefix, keep the rest incl. query string
  const sfPath = req.originalUrl.replace(/^\/api\/salesforce\//, "");
  const url = `${sf.instanceUrl}/${sfPath}`;

  const doFetch = (token) =>
    fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : JSON.stringify(req.body),
    });

  try {
    let r = await doFetch(sf.accessToken);
    if (r.status === 401) {
      const newToken = await refreshSalesforce(req);
      r = await doFetch(newToken);
    }
    const data = await r.text();
    res.status(r.status).type("application/json").send(data);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "Salesforce request failed" });
  }
});

// --- optional: a quick way for React to check auth status ---
app.get("/api/auth/status", (req, res) => {
  res.json({ authenticated: Boolean(req.session.sf) });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
