// Encryption at rest for Salesforce tokens. Run with: npm test
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { loadKey, isSealed, seal, unseal } from "./tokenCrypto.js";

const KEY = loadKey(crypto.randomBytes(32).toString("base64"));
const OTHER = loadKey(crypto.randomBytes(32).toString("base64"));
const USER = "11111111-1111-1111-1111-111111111111";
const TOKEN = "5Aep861_refresh_token_value.with-punctuation!";

test("round-trips a token", () => {
  assert.equal(unseal(seal(TOKEN, USER, KEY), USER, KEY), TOKEN);
});

test("the stored value does not contain the token", () => {
  const sealed = seal(TOKEN, USER, KEY);
  assert.ok(isSealed(sealed));
  assert.ok(!sealed.includes(TOKEN), "plaintext leaked into the ciphertext");
  assert.ok(!sealed.includes("refresh_token_value"));
});

test("a fresh IV each time, so equal tokens do not look equal", () => {
  assert.notEqual(seal(TOKEN, USER, KEY), seal(TOKEN, USER, KEY));
});

test("the wrong key cannot open it", () => {
  assert.equal(unseal(seal(TOKEN, USER, KEY), USER, OTHER), null);
});

test("a ciphertext moved to another user's row will not open", () => {
  // The whole point of binding the user id in as AAD: someone with write access to the
  // table can't copy an admin's token into their own row and use it.
  const mine = seal(TOKEN, USER, KEY);
  assert.equal(unseal(mine, "22222222-2222-2222-2222-222222222222", KEY), null);
});

test("tampering is detected rather than silently accepted", () => {
  const [v, iv, tag, ct] = seal(TOKEN, USER, KEY).split(":");
  const flip = (b64) => { const b = Buffer.from(b64, "base64"); b[0] ^= 1; return b.toString("base64"); };
  assert.equal(unseal([v, iv, tag, flip(ct)].join(":"), USER, KEY), null, "flipped ciphertext");
  assert.equal(unseal([v, flip(iv), tag, ct].join(":"), USER, KEY), null, "flipped IV");
  assert.equal(unseal([v, iv, flip(tag), ct].join(":"), USER, KEY), null, "flipped tag");
  assert.equal(unseal("v1:garbage", USER, KEY), null, "malformed");
});

test("legacy plaintext rows still read, so enabling the key does not break live connections", () => {
  assert.equal(unseal(TOKEN, USER, KEY), TOKEN);
  assert.ok(!isSealed(TOKEN));
});

test("with no key configured it stays plaintext (unchanged behaviour)", () => {
  assert.equal(seal(TOKEN, USER, null), TOKEN);
  assert.equal(unseal(TOKEN, USER, null), TOKEN);
});

test("a sealed value is never handed back raw when the key is missing", () => {
  // Returning the ciphertext here would send "v1:…" to Salesforce as a bearer token —
  // failing closed is the only safe answer.
  assert.equal(unseal(seal(TOKEN, USER, KEY), USER, null), null);
});

test("key loading accepts hex and base64, and rejects a wrong-sized key", () => {
  const bytes = crypto.randomBytes(32);
  assert.equal(loadKey(bytes.toString("hex")).toString("hex"), bytes.toString("hex"));
  assert.equal(loadKey(bytes.toString("base64")).toString("hex"), bytes.toString("hex"));
  assert.equal(loadKey(""), null);
  assert.equal(loadKey(undefined), null);
  // A short key must throw, not quietly fall back to plaintext.
  assert.throws(() => loadKey(crypto.randomBytes(16).toString("base64")), /32 bytes/);
  assert.throws(() => loadKey("not-a-real-key"), /32 bytes/);
});

test("survives a token with unicode and separator characters", () => {
  const odd = "aa:bb:cc\nDD üñî ✓";
  assert.equal(unseal(seal(odd, USER, KEY), USER, KEY), odd);
});
