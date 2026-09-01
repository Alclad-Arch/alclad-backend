// One-off: get a refresh token for the SERVICE IDENTITY that reads MYOB Acumatica.
//
//   node authorize-myob.js
//
// Runs the OAuth authorization-code flow once against the Connected Application created for
// the service, prints the refresh token and exits. It writes NOTHING — no file, no database
// row — so the only copy of the token is the one you paste into Render. Nothing here is wired
// into the running server.
//
// Sibling of authorize-service.js, which does the same job for Salesforce. Same shape on
// purpose: whoever runs one should recognise the other.
//
// Prerequisites:
//   • a Connected Application on the Acumatica instance (screen SM303010) with
//       OAuth 2.0 Flow  = Authorization Code
//       Redirect URI    = exactly http://localhost:3001/api/myob/callback
//       a shared secret created (its value is shown ONCE — copy it then)
//   • REFRESH TOKENS ENABLED on that application. Requesting offline_access is not enough:
//     Acumatica returns no refresh token if the application itself does not permit them,
//     and the failure looks like a successful login with a token exchange that comes back
//     without the field.
//
// Sign in as the account that will hold the licence — whoever approves is the identity every
// app user reads Acumatica as.
import "dotenv/config";
import crypto from "crypto";
import http from "http";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "node:process";

const PORT = 3001;
const REDIRECT = `http://localhost:${PORT}/api/myob/callback`;
const INSTANCE = (process.env.MYOB_INSTANCE_URL || "https://alcladarchitectural.myobadvanced.com").replace(/\/+$/, "");
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const rl = readline.createInterface({ input, output });
const ask = async (q, fallback) => {
  const a = (await rl.question(fallback ? `${q} [${fallback}]: ` : `${q}: `)).trim();
  return a || fallback || "";
};

console.log("\nService-account authorization — MYOB Acumatica\n");
console.log(`Instance:   ${INSTANCE}`);
console.log(`Callback:   ${REDIRECT}   (must match the Connected Application exactly)\n`);

const clientId = await ask("Client ID", process.env.MYOB_CLIENT_ID || "");
const clientSecret = await ask("Client Secret", process.env.MYOB_CLIENT_SECRET || "");
if (!clientId || !clientSecret) {
  console.error("\nBoth are required — from the Connected Application header and its Secrets tab.\n");
  rl.close(); process.exit(1);
}

// PKCE as well as the secret. Acumatica accepts a confidential client without it, but the
// verifier costs nothing and means an intercepted code is useless on its own.
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

// api      — the contract-based REST endpoints (/entity/...)
// offline_access — without it no refresh token comes back at all
const SCOPE = "api offline_access";

const authUrl = `${INSTANCE}/identity/connect/authorize?response_type=code`
  + `&client_id=${encodeURIComponent(clientId)}`
  + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
  + `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`
  + `&scope=${encodeURIComponent(SCOPE)}`;

console.log("\nOpen this in the browser, signed in as the service identity:\n");
console.log(authUrl + "\n");
console.log(`Waiting for the callback on :${PORT} …  (Ctrl+C to abort)\n`);

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (!u.pathname.startsWith("/api/myob/callback")) { res.writeHead(404).end(); return; }
    const err = u.searchParams.get("error");
    const got = u.searchParams.get("code");
    const gotState = u.searchParams.get("state");
    res.writeHead(200, { "Content-Type": "text/html" });
    if (err) {
      const desc = u.searchParams.get("error_description") || "";
      res.end(`<h2>Acumatica returned an error</h2><p>${err}</p><p>${desc}</p><p>Back to the terminal.</p>`);
      server.close(); return reject(new Error(`${err}${desc ? " — " + desc : ""}`));
    }
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
const r = await fetch(`${INSTANCE}/identity/connect/token`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
});
const t = await r.json().catch(() => ({}));
if (!r.ok || !t.refresh_token) {
  console.error("\nToken exchange failed:", r.status, JSON.stringify(t, null, 2));
  console.error("\nUsual causes:");
  console.error("  • the Redirect URI does not match the Connected Application EXACTLY");
  console.error("  • refresh tokens are not enabled on the Connected Application — a 200 with an");
  console.error("    access_token but no refresh_token is this, not a network problem");
  console.error("  • the secret was regenerated after it was copied\n");
  rl.close(); process.exit(1);
}

// Prove the token actually reaches the API before declaring success — an authorization that
// works but cannot read Projects is worth finding out about now, not in the first sync.
let probe = "not attempted";
try {
  const p = await fetch(`${INSTANCE}/entity/Default/24.200.001/Project?$top=1&$select=ProjectID`, {
    headers: { Authorization: `Bearer ${t.access_token}`, Accept: "application/json" },
  });
  probe = p.ok ? `OK (${p.status}) — Project is readable` : `FAILED (${p.status}) — ${(await p.text()).slice(0, 160)}`;
} catch (e) { probe = `FAILED — ${e.message}`; }

console.log("\n" + "=".repeat(72));
console.log(`API probe: ${probe}`);
console.log("\nSet these on Render (alclad-backend → Environment), then let it redeploy:\n");
console.log(`MYOB_INSTANCE_URL=${INSTANCE}`);
console.log(`MYOB_ENDPOINT_VERSION=24.200.001`);
console.log(`MYOB_CLIENT_ID=${clientId}`);
console.log(`MYOB_CLIENT_SECRET=${clientSecret}`);
console.log(`MYOB_SERVICE_REFRESH_TOKEN=${t.refresh_token}`);
console.log("=".repeat(72));
console.log("\nThe refresh token is printed once and stored nowhere. Copy it now.\n");

rl.close();
