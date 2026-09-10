// The OData probe's addresses and how it reads a status.
//
// A diagnostic is trusted precisely because nobody double-checks it, and this one feeds a
// purchasing decision: if it probes the wrong address it reports a confident 404, which reads as
// "OData is closed too" and sends someone off buying an API entitlement they may not need.
//
// So the two things that can be wrong without anyone noticing are tested here: the URL shapes,
// and the meaning attached to each status code.
import assert from "node:assert/strict";
import test from "node:test";
import { odataCandidates, readOdataStatus, authHeader } from "./myobOdata.js";

const INST = "https://alclad.myobadvanced.com";

test("asks the service document first — the cheapest request, and the one that lists what is readable", () => {
  const c = odataCandidates(INST, "", "");
  assert.equal(c[0].url, `${INST}/OData`);
});

test("a trailing slash on the instance does not produce a doubled one", () => {
  const c = odataCandidates(INST + "/", "", "");
  assert.ok(c.every((x) => !x.url.includes("//OData") && !x.url.includes(".com//")), c.map((x) => x.url).join(" "));
});

test("without a tenant, no tenant-scoped address is built", () => {
  /* The failure this prevents: building /OData/undefined, which 404s and reads as a refusal
     rather than as a question nobody asked. */
  const c = odataCandidates(INST, "", "");
  assert.ok(c.every((x) => !/undefined|\/\//.test(x.url.replace("https://", ""))), c.map((x) => x.url).join(" "));
  assert.ok(!c.some((x) => x.label.includes("tenant")));
});

test("with a tenant, both the classic and the v4 routes are covered", () => {
  const urls = odataCandidates(INST, "Alclad", "").map((x) => x.url);
  assert.ok(urls.includes(`${INST}/OData/Alclad`), urls.join(" "));
  assert.ok(urls.includes(`${INST}/t/Alclad/api/odata/gi`), urls.join(" "));
});

test("a tenant with a space is encoded, not pasted raw into the path", () => {
  const urls = odataCandidates(INST, "Alclad Arch", "").map((x) => x.url);
  assert.ok(urls.some((u) => u.includes("Alclad%20Arch")), urls.join(" "));
  assert.ok(!urls.some((u) => u.includes("Alclad Arch")), urls.join(" "));
});

test("a named inquiry is asked for ONE row, on both routes", () => {
  const c = odataCandidates(INST, "Alclad", "Alclad-ProjectActuals");
  const gi = c.filter((x) => x.label.startsWith("GI"));
  assert.equal(gi.length, 2);
  assert.ok(gi.every((x) => x.url.includes("$top=1")), gi.map((x) => x.url).join(" "));
  assert.ok(gi.every((x) => x.url.includes("Alclad-ProjectActuals")), gi.map((x) => x.url).join(" "));
});

test("no inquiry named, no inquiry probed", () => {
  assert.ok(!odataCandidates(INST, "Alclad", "").some((x) => x.label.startsWith("GI")));
});

/* ── the statuses, which are the actual finding ────────────────────────────────────────────
   401 vs 403 is the difference between "try other credentials" and "this tenant is not
   entitled" — one is a five-minute retry and the other is a purchase. They must never read
   alike. */
test("200 is the finding we are hoping for", () => {
  assert.equal(readOdataStatus(200).verdict, "OPEN");
});

test("401 says the surface is REACHABLE and points at Basic auth", () => {
  const r = readOdataStatus(401);
  assert.equal(r.verdict, "AUTH");
  assert.match(r.note, /Basic/);
  assert.match(r.note, /reachable/i);
});

test("403 is named as the same wall, not as a new one", () => {
  const r = readOdataStatus(403);
  assert.equal(r.verdict, "REFUSED");
  assert.match(r.note, /same wall/i);
});

test("404 is explicitly NOT a rights answer", () => {
  assert.match(readOdataStatus(404).note, /not a rights answer/i);
});

test("405 and 5xx both say the endpoint EXISTS — the surface is there either way", () => {
  assert.match(readOdataStatus(405).note, /surface is there/i);
  assert.match(readOdataStatus(500).note, /exists/i);
});

/* ── auth ─────────────────────────────────────────────────────────────────────────────────── */
test("bearer is the default", () => {
  assert.equal(authHeader("bearer", { token: "abc" }), "Bearer abc");
});

test("basic encodes the pair", () => {
  assert.equal(authHeader("basic", { user: "u", pass: "p" }),
    "Basic " + Buffer.from("u:p").toString("base64"));
});

test("basic with no credentials returns null rather than a header that cannot work", () => {
  /* Sending "Basic " with an empty pair gets a 401 that looks like a rejected password, which
     would be read as "the credentials are wrong" when none were supplied at all. */
  assert.equal(authHeader("basic", { user: "", pass: "" }), null);
  assert.equal(authHeader("basic", {}), null);
});

test("bearer with no token returns null for the same reason", () => {
  assert.equal(authHeader("bearer", {}), null);
});
