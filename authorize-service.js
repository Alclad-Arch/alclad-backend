// One-off: get a refresh token for the SERVICE IDENTITY behind /api/salesforce/opportunity-summary.
//
//   node authorize-service.js
//
// Runs the OAuth authorization-code flow once against the connected app you created for
// the service, prints the refresh token and instance URL, and exits. It writes NOTHING —
// no file, no database row — so the only copy of the token is the one you paste into
// Render. Nothing here is wired into the running server.
//
// Prerequisites (see docs/salesforce-service-account.md in the app repo):
//   • a Connected App created for the SERVICE, separate from the per-user login app —
//     sharing a grant means Salesforce's refresh-token rotation kills one of the two
//   • its callback URL set to exactly http://localhost:3001/api/oauth/callback
//   • ~10 minutes elapsed since you saved it (Salesforce propagation)
//
// Sign in to Salesforce as the account that will hold the licence BEFORE running this,
// or sign in when the browser opens — whoever approves is the identity every unlinked
// app user will read Salesforce as.
import "dotenv/config";
import crypto from "crypto";
import http from "http";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "node:process";

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

console.log("\n" + "=".repeat(72));
console.log("Set these on Render (alclad-backend → Environment), then let it redeploy:\n");
console.log(`SF_SERVICE_REFRESH_TOKEN=${t.refresh_token}`);
console.log(`SF_SERVICE_INSTANCE_URL=${t.instance_url || ""}`);
console.log(`SF_SERVICE_CLIENT_ID=${clientId}`);
console.log(`SF_SERVICE_CLIENT_SECRET=${clientSecret}`);
console.log("=".repeat(72));
console.log("\nTreat the refresh token as a password: it is a standing login to Salesforce");
console.log("as whoever just approved. Nothing was written to disk — this terminal is the");
console.log("only copy, so clear the scrollback once it's in Render.\n");
rl.close();
