// Sal's own Salesforce allowance (Jed 2026-11-17). At 7:42 the Network Map page read hundreds of Salesforce queries
// under Jed's login; the backend's 60-a-minute cap tripped, and Sal — asked at that moment, on the SAME allowance —
// was refused ("Salesforce is rate-limiting us"). Now the cap is per person AND per purpose: Sal's route has its own.
// server.js starts a listener when imported, so these read its source (as other route checks do).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./server.js", import.meta.url), "utf8");

test("the cap is kept per person AND per purpose (bucket), 'app' by default", () => {
  assert.match(src, /function rateLimit\(\{ perMin, perDay, action, bucket = "app" \}\)/);
  assert.match(src, /const key = `\$\{req\.userId\}:\$\{bucket\}`;/);
  assert.match(src, /_buckets\.get\(key\)/);
});

test("Sal has his own route on his own allowance, registered BEFORE the general route", () => {
  const sal = src.indexOf('app.get("/api/salesforce/sal/q/*splat"');
  const gen = src.indexOf('app.get("/api/salesforce/*splat"');
  assert.ok(sal > 0 && gen > 0 && sal < gen, "Sal's route must come first, or the general route swallows it");
  assert.match(src, /app\.get\("\/api\/salesforce\/sal\/q\/\*splat", requireUser, rateLimit\(\{[^}]*bucket: "sal" \}\), sfProxy\(/);
});

test("both routes run the SAME proxy (same allowed paths, checks and audit) — only the prefix and allowance differ", () => {
  assert.match(src, /const sfProxy = \(prefix, act\) => async \(req, res\) => \{/);
  assert.match(src, /sfProxy\(\/\^\\\/api\\\/salesforce\\\/sal\\\/q\\\/\/i, "sal_proxy"\)/);
  assert.match(src, /sfProxy\(\/\^\\\/api\\\/salesforce\\\/\/i, "proxy"\)/);
  assert.ok((src.match(/SF_PATH_OK\.test\(sfPath\)/g) || []).length >= 1, "the allowed-path check stays in the shared handler");
});

test("Sal's other routes (me, apply) are on his allowance too; the pages' routes stay on 'app'", () => {
  assert.match(src, /action: "sal_me", bucket: "sal" \}/);
  assert.match(src, /action: "sal_apply", bucket: "sal" \}/);
  assert.doesNotMatch(src, /action: "proxy", bucket:/);
});
