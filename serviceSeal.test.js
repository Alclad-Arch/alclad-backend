// The service token written by authorize-service.js must be readable by server.js.
//
// Added 2026-09-09 after the Salesforce service account died twice in a week. The cause was not
// encryption but PRECEDENCE: sfServiceRefreshToken() reads the STORED ROW first and only falls
// back to SF_SERVICE_REFRESH_TOKEN when no row exists — so once a row is there, re-issuing and
// setting the env var does nothing, and the dead stored token keeps being sent to Salesforce.
// authorize-service.js therefore writes the row itself now.
//
// Which creates a new way to fail silently: if it seals with a different AAD than the server
// unseals with, the stored value cannot be opened. server.js logs "could not be decrypted" and
// falls back to the stale env var — the exact invisible failure this set out to end. So the two
// sides of that contract are pinned here.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadKey, seal, unseal, isSealed } from "./tokenCrypto.js";

// The one string both sides must agree on. server.js: const SF_SVC_SEAL_ID = "salesforce_service"
const SEAL_ID = "salesforce_service";
const KEY = loadKey(crypto.randomBytes(32).toString("base64"));
const TOKEN = "5Aep861_service_refresh.token-value!";

test("what authorize-service seals, the server can unseal", () => {
  const stored = seal(TOKEN, SEAL_ID, KEY);          // as authorize-service.js writes it
  assert.ok(isSealed(stored), "should be sealed when a key is set");
  assert.equal(unseal(stored, SEAL_ID, KEY), TOKEN); // as server.js reads it
});

test("a different seal id cannot open it — which is why the id is not a guess", () => {
  const stored = seal(TOKEN, SEAL_ID, KEY);
  assert.equal(unseal(stored, "salesforce", KEY), null,
    "a mismatched AAD returns null, and the server then falls back to the stale env var");
});

test("no key means plaintext, which the server's isSealed check tolerates", () => {
  const stored = seal(TOKEN, SEAL_ID, undefined);
  assert.equal(stored, TOKEN);
  assert.equal(unseal(stored, SEAL_ID, undefined), TOKEN);
});

// ── the contract, read off both files rather than remembered ────────────────────────────────
const svc = readFileSync("./authorize-service.js", "utf8");
const srv = readFileSync("./server.js", "utf8");

test("both sides use the same seal id", () => {
  assert.match(srv, /SF_SVC_SEAL_ID = "salesforce_service"/);
  assert.match(svc, /sealWith\(t\.refresh_token, "salesforce_service", key\)/);
});

test("both sides use the same provider key", () => {
  assert.match(srv, /SF_SVC_PROVIDER = "salesforce_service"/);
  assert.match(svc, /provider: "salesforce_service"/);
});

test("the script writes the row, since the env var is unread once one exists", () => {
  assert.match(svc, /from\("integration_tokens"\)\.upsert/);
  // and it says so where someone reading it would otherwise trust the old header
  assert.match(svc, /WRITES THE TOKEN STRAIGHT INTO integration_tokens/);
});

test("rotated_count resets, so a fresh grant does not look like a rotated one", () => {
  assert.match(svc, /rotated_count: 0/);
});

test("it tells you what to do when it cannot store", () => {
  // Without this the token is minted, unstored, and the server keeps reading the dead row —
  // which is precisely the failure being fixed, reintroduced by a missing env var.
  assert.match(svc, /delete from public\.integration_tokens where provider = 'salesforce_service'/);
});
