// One-off: get a refresh token for the SERVICE IDENTITY behind /api/salesforce/opportunity-summary.
//
//   node authorize-service.js
//
// Runs the OAuth authorization-code flow once against the connected app you created for
// the service, then WRITES THE TOKEN STRAIGHT INTO integration_tokens — the same row the
// server reads — and prints it as well.
//
// ── WHY IT WRITES NOW (2026-09-09) ──
// It used to only print, on the reasoning that the terminal should be the token's only copy.
// That made the documented recovery impossible in the state it is most needed. Look at the
// order in sfServiceRefreshToken(): the STORED ROW WINS, and the env var is only read when
// no row exists. So once integration_tokens holds a salesforce_service row — which it does
// as soon as the first refresh rotates — re-issuing and setting SF_SERVICE_REFRESH_TOKEN
// does NOTHING. The fresh token sits in the env var, unread, while the dead stored one keeps
// being sent to Salesforce and rejected as invalid_grant.
//
// That is what happened on 2026-09-03 and again on 2026-09-09: the same fix applied twice,
// appearing to work and then not, because the second time there was a row in the way. The
// error message the app shows still said "set SF_SERVICE_REFRESH_TOKEN once to reseed",
// which cannot work with a row present.
//
// So the token now goes where the server will actually read it. The env var remains as the
// cold-start bootstrap for a database that has never held a row.
//
// Prerequisites (see docs/salesforce-service-account.md in the app repo):
//   • a Connected App created for the SERVICE, separate from the per-user login app —
//     sharing a grant means Salesforce's refresh-token rotation kills one of the two
//   • its callback URL set to exactly http://localhost:3001/api/oauth/callback
//   • ~10 minutes elapsed since you saved it (Salesforce propagation)
//
// ⚠ IT WRITES TO WHATEVER SUPABASE_URL POINTS AT — which in this repo's .env is DEV, not prod.
//    Jed hit that on 2026-09-09: the write failed with "table not in the schema cache" because
//    dev has never had 20260903_integration_tokens.sql run against it. To fix the PROD grant,
//    delete prod's row so the env-var bootstrap is reachable, run this for the token, and set
//    SF_SERVICE_REFRESH_TOKEN on Render — the server then persists the rotation into prod itself,
//    sealed with prod's own TOKEN_ENC_KEY, which is where it belongs. Pointing this script at
//    prod would mean prod's service-role key sitting in a local .env, which is worse.
//
// Sign in to Salesforce as the account that will hold the licence BEFORE running this,
// or sign in when the browser opens — whoever approves is the identity every unlinked
// app user will read Salesforce as.
import "dotenv/config";
import crypto from "crypto";
import http from "http";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createClient } from "@supabase/supabase-js";
import { loadKey, seal as sealWith } from "./tokenCrypto.js";

const PORT = 3001;
const REDIRECT = `http://localhost:${PORT}/api/oauth/callback`;
const LOGIN = process.env.SF_LOGIN_URL || "https://login.salesforce.com";
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const rl = readline.createInterface({ input, output });
const ask = async (q, fallback) => {
  const a = (await rl.question(fallback ? `${q} [${fallback}]: ` : `${q}: `)).trim();
  return a || fallback || "";
};

console.log("\nService-account authorization — Salesforce\n");
console.log(`Login URL:    ${LOGIN}`);
console.log(`Callback:     ${REDIRECT}   (must match the Connected App exactly)\n`);

const clientId = await ask("Consumer Key", process.env.SF_SERVICE_CLIENT_ID || "");
const clientSecret = await ask("Consumer Secret", process.env.SF_SERVICE_CLIENT_SECRET || "");
if (!clientId || !clientSecret) { console.error("\nBoth are required — copy them from Manage Consumer Details on the Connected App.\n"); rl.close(); process.exit(1); }

const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

const authUrl = `${LOGIN}/services/oauth2/authorize?response_type=code`
  + `&client_id=${encodeURIComponent(clientId)}`
  + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
  + `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`
  + `&scope=${encodeURIComponent("api refresh_token offline_access")}`;

console.log("\nOpen this in the browser, signed in as the service identity:\n");
console.log(authUrl + "\n");
console.log(`Waiting for the callback on :${PORT} …  (Ctrl+C to abort)\n`);

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (!u.pathname.startsWith("/api/oauth/callback")) { res.writeHead(404).end(); return; }
    const err = u.searchParams.get("error");
    const got = u.searchParams.get("code");
    const gotState = u.searchParams.get("state");
    res.writeHead(200, { "Content-Type": "text/html" });
    if (err) { res.end(`<h2>Salesforce returned an error</h2><p>${err}</p><p>Back to the terminal.</p>`); server.close(); return reject(new Error(err)); }
    if (gotState !== state) { res.end("<h2>State mismatch</h2><p>Abandoned — start again.</p>"); server.close(); return reject(new Error("state mismatch")); }
    res.end("<h2>Approved</h2><p>Done — the refresh token is in your terminal. You can close this tab.</p>");
    server.close();
    resolve(got);
  });
  server.on("error", (e) => reject(new Error(e.code === "EADDRINUSE"
    ? `port ${PORT} is busy — stop the local backend (npm start) and run this again`
    : e.message)));
  server.listen(PORT);
}).catch((e) => { console.error("\n" + e.message + "\n"); rl.close(); process.exit(1); });

const body = new URLSearchParams({
  grant_type: "authorization_code",
  code, client_id: clientId, client_secret: clientSecret,
  redirect_uri: REDIRECT, code_verifier: verifier,
});
const r = await fetch(`${LOGIN}/services/oauth2/token`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
});
const t = await r.json();
if (!r.ok || !t.refresh_token) {
  console.error("\nToken exchange failed:", r.status, JSON.stringify(t, null, 2));
  console.error("\nUsual causes: the callback URL doesn't match the Connected App exactly,");
  console.error("the app was saved less than ~10 minutes ago, or offline_access wasn't granted.\n");
  rl.close(); process.exit(1);
}

// ── write it where the server reads it ──────────────────────────────────────────────────────
// Sealed exactly as server.js does (seal(token, SF_SVC_SEAL_ID) with TOKEN_ENC_KEY), because the
// server unseals with the same id — a mismatch there stores a token nothing can open, which reads
// as "could not be decrypted" and silently falls back to the stale env var. Plaintext when no key
// is set, which the server's isSealed() check already tolerates.
let stored = false;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.warn("\n⚠ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set here, so the token was NOT stored.");
  console.warn("  Set them in this repo's .env and re-run, or delete the stored row so the env var");
  console.warn("  bootstrap below is reachable:");
  console.warn("    delete from public.integration_tokens where provider = 'salesforce_service';");
} else {
  const key = loadKey(process.env.TOKEN_ENC_KEY);
  const value = key ? sealWith(t.refresh_token, "salesforce_service", key) : t.refresh_token;
  const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
  /* rotated_count RESET TO 0, deliberately: this is a new grant, and the count is the health
     signal for how many times THIS grant has rotated. Carrying the old number forward would make
     a fresh, never-refreshed token look like a working one. */
  const { error } = await supa.from("integration_tokens").upsert({
    provider: "salesforce_service",
    refresh_token: value,
    rotated_count: 0,
    meta: { instance: t.instance_url || "", note: "re-issued by authorize-service.js" },
    updated_at: new Date().toISOString(),
    updated_by: "authorize-service.js",
  });
  if (error) {
    console.error("\n⚠ Could not store the token:", error.message);
    console.error("  The token below is still valid — set it on Render, and delete the stored row");
    console.error("  first or the server will keep reading the old one:");
    console.error("    delete from public.integration_tokens where provider = 'salesforce_service';");
  } else {
    stored = true;
    console.log("\n✓ Stored in integration_tokens (provider = salesforce_service)" + (key ? ", sealed." : ", PLAINTEXT — TOKEN_ENC_KEY is not set here."));
    console.log("  The server reads this row in preference to the environment variable, so it is");
    console.log("  live as soon as it next asks for a token.");
  }
}

console.log("\n" + "=".repeat(72));
console.log(stored
  ? "Already stored. Set these on Render too, as the cold-start bootstrap:\n"
  : "Set these on Render (alclad-backend → Environment), then let it redeploy:\n");
console.log(`SF_SERVICE_REFRESH_TOKEN=${t.refresh_token}`);
console.log(`SF_SERVICE_INSTANCE_URL=${t.instance_url || ""}`);
console.log(`SF_SERVICE_CLIENT_ID=${clientId}`);
console.log(`SF_SERVICE_CLIENT_SECRET=${clientSecret}`);
console.log("=".repeat(72));
console.log("\nTreat the refresh token as a password: it is a standing login to Salesforce");
console.log("as whoever just approved. Clear the scrollback once it is in Render.\n");
if (stored) {
  console.log("Check it with /api/salesforce/service-status — expect ok:true, seeded:false, and");
  console.log("rotations climbing over the next day. A flatlined count means refresh has stopped");
  console.log("and the grant is drifting toward its 30-day idle expiry.\n");
}
rl.close();
