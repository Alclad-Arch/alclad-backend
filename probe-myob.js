// Check what the MYOB Acumatica service identity can actually read.
//
//   node probe-myob.js
//
// Read-only against Acumatica: every call is a GET with $top=1. Nothing is written there.
//
// The refresh token is handled by myobToken.js, which keeps it in public.integration_tokens
// and writes back every rotation. So this is safe to re-run as often as you like — the first
// version rotated the token on each run and left the copy in Render dead, which made
// diagnosing an access-rights problem cost a Render edit per attempt.
//
// Needs, in this shell or a .env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY     (where the refresh token is kept)
//   MYOB_INSTANCE_URL, MYOB_CLIENT_ID, MYOB_CLIENT_SECRET
//   MYOB_SERVICE_REFRESH_TOKEN                  (bootstrap only — ignored once the row exists)
//   TOKEN_ENC_KEY                               (optional; encrypts the stored token at rest)
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { myobGet, myobConfig, lastScope } from "./myobToken.js";

const need = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MYOB_INSTANCE_URL", "MYOB_CLIENT_ID", "MYOB_CLIENT_SECRET"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\nMissing: ${missing.join(", ")}\nSet them in this shell and re-run.\n`);
  process.exit(1);
}

// Preflight the Supabase credentials before touching Acumatica. A Supabase key is a JWT that
// names its own role and project, so the two commonest mistakes — using the anon key, or a key
// from the other project — are detectable here rather than surfacing as a flat "Invalid API
// key" against every entity, which reads like an Acumatica problem and is not.
function describeKey(key) {
  try {
    const payload = JSON.parse(Buffer.from(String(key).split(".")[1], "base64url").toString("utf8"));
    return { role: payload.role || "?", ref: payload.ref || "?" };
  } catch { return null; }
}
const urlRef = (String(process.env.SUPABASE_URL).match(/^https:\/\/([a-z0-9]+)\./) || [])[1] || "?";
const keyInfo = describeKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
if (keyInfo) {
  const problems = [
    keyInfo.role !== "service_role" && `the key's role is "${keyInfo.role}", not service_role — this table is readable by service_role ONLY`,
    keyInfo.ref !== urlRef && `the key belongs to project "${keyInfo.ref}" but SUPABASE_URL points at "${urlRef}"`,
  ].filter(Boolean);
  if (problems.length) {
    console.error(`\nSupabase credentials look wrong:\n${problems.map((p) => "  • " + p).join("\n")}\n`);
    console.error(`Copy the service_role key from the project matching ${urlRef}.\n`);
    process.exit(1);
  }
} else {
  // Fail here rather than warning and carrying on. A value that is not a JWT is definitely
  // not a Supabase key, and the first version's warning let a 23-character placeholder —
  // the literal text "<prod service role key>" — reach Supabase and come back as "Invalid
  // API key" against all five entities, which read as an Acumatica fault.
  const k = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
  console.error(`\nSUPABASE_SERVICE_ROLE_KEY is not a JWT (${k.length} chars, ${k.split(".").length} segment(s)).`);
  if (k.startsWith("<")) console.error("It still looks like a placeholder — replace it with the real value.");
  console.error("A service_role key starts \"eyJ\", has three dot-separated segments and runs 200+ chars.\n");
  process.exit(1);
}

// Same trap, same fix, for every other value this needs.
const placeholders = ["SUPABASE_URL", "MYOB_INSTANCE_URL", "MYOB_CLIENT_ID", "MYOB_CLIENT_SECRET", "MYOB_SERVICE_REFRESH_TOKEN"]
  .filter((k) => String(process.env[k] || "").startsWith("<"));
if (placeholders.length) {
  console.error(`\nStill placeholders, not real values: ${placeholders.join(", ")}\n`);
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const cfg = myobConfig();
console.log(`\nMYOB Acumatica probe\n${cfg.instance}  ·  Default ${cfg.version}`);
console.log(`token store: public.integration_tokens${cfg.encKey ? " (encrypted at rest)" : " (plaintext — TOKEN_ENC_KEY unset)"}\n`);

// One row from each entity the integration needs. Reported separately so one missing screen
// right does not read as "the whole thing is broken".
//
// No $select on CostCode: the first version asked for a field of that name and Acumatica
// answered 500 "The given key was not present in the dictionary" — a malformed request, not a
// rights problem, which is exactly the confusion a probe should not create.
// CONTROLS come first, deliberately. Nathan can open PM301000 in the browser, the role has
// View Only on it, the authorisation is fresh and the client id carries the right tenant —
// and it still 403s. So the question is no longer "which right is missing" but "does this
// token have ANY rights". These entities are ordinary things a full user reads; if they fail
// too, the fault is token-wide (the Connected Application, the scope, or endpoint access) and
// nothing about the Projects screen matters.
const CHECKS = [
  ["Account", "$top=1"],
  ["Customer", "$top=1"],
  ["Employee", "$top=1"],
  // ── the ones the integration actually needs ──
  ["Project", "$top=1&$select=ProjectID,Description,Status"],
  ["ProjectBudget", "$top=1"],
  ["ProjectTask", "$top=1"],
  ["ProjectTransaction", "$top=1"],
  ["CostCode", "$top=1"],
];

const results = [];
for (const [entity, query] of CHECKS) {
  try {
    const rows = await myobGet(db, entity, query);
    results.push([entity, "OK", Array.isArray(rows) ? `${rows.length} row(s)` : "read"]);
  } catch (e) {
    const status = e.status ? `HTTP ${e.status}` : "ERROR";
    results.push([entity, status, String(e.message).replace(/^MYOB \S+ \d+: /, "").slice(0, 120)]);
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad("ENTITY", 22) + pad("RESULT", 10) + "DETAIL");
console.log("-".repeat(96));
for (const [e, s, d] of results) console.log(pad(e, 22) + pad(s, 10) + d);

// What the token ACTUALLY carries. Authentication succeeding tells you nothing about whether
// the token is entitled to the API: a token issued WITHOUT the api scope refreshes happily
// and 403s on everything, which is indistinguishable from a permissions problem until you
// look at this line.
console.log(`\ngranted scope: ${lastScope() || "(no refresh ran)"}`);

// WHO does this token think it is? The scope is right, the tenant is right, the user has UI
// access to these forms, and every one is refused — so the remaining question is whether the
// token represents the identity we assume. OIDC's userinfo endpoint answers it directly, and
// asking should have come long before five rounds of granting rights.
try {
  const { getMyobAccessToken } = await import("./myobToken.js");
  const token = await getMyobAccessToken(db);
  const who = await fetch(`${cfg.instance}/identity/connect/userinfo`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await who.text().catch(() => "");
  console.log(`identity (userinfo ${who.status}): ${text.replace(/\s+/g, " ").slice(0, 220) || "(empty)"}`);
} catch (e) {
  console.log(`identity: could not be read — ${(e && e.message) || e}`);
}

const ok = results.filter((r) => r[1] === "OK").length;
console.log(`\n${ok} of ${results.length} readable.`);

// Read the controls separately — the shape of the failure says where to look next.
const CONTROLS = ["Account", "Customer", "Employee"];
const controlsOk = results.filter((r) => CONTROLS.includes(r[0]) && r[1] === "OK").length;
if (controlsOk === 0) {
  console.log("\nDIAGNOSIS: the token has no rights to ANYTHING, not just Projects.");
  console.log("So this is not about the Projects screen or the role granted on it. Look at the");
  console.log("Connected Application itself, the granted scope, or access rights on the web");
  console.log("service ENDPOINT (there is an 'Integration' node in the access-rights tree).");
} else if (controlsOk === CONTROLS.length && results.some((r) => r[0] === "Project" && r[1] !== "OK")) {
  console.log("\nDIAGNOSIS: ordinary entities read fine, so the token and endpoint are healthy.");
  console.log("The refusal is specific to the Projects forms — which means a rights or licence");
  console.log("gate on the Project Accounting module rather than anything about the connection.");
}

// Only worth saying when the connection is otherwise healthy. Printing "grant the role View
// Only on that screen" while EVERY entity is refused sent us round Acumatica five times
// granting rights that were never the problem.
if (ok < results.length && controlsOk > 0) {
  console.log("\nA 403 naming a form is an access-rights gap, not a broken connection: open that");
  console.log("screen in Acumatica, Tools -> Access Rights, give the role View Only, and re-run.");
  console.log("Re-running is free now — the rotated refresh token is stored, not printed.\n");
} else if (ok === results.length) {
  console.log("\nEverything the integration needs is readable.\n");
}

// Show the rotation counter: it proves the storage path is actually being written, which is
// the half of this that has no other visible symptom until it fails.
const { data } = await db.from("integration_tokens").select("rotated_count, updated_at").eq("provider", "myob").maybeSingle();
if (data) console.log(`refresh token rotated ${data.rotated_count} time(s), last written ${data.updated_at}\n`);

/* ── THE OTHER DOOR: OData ────────────────────────────────────────────────────────────────────
 *
 * Everything above probes /entity/Default/<version>/… — the contract-based REST API. Acumatica
 * family systems expose OData over Generic Inquiries as a SEPARATE surface, with its own
 * entitlement and its own auth.
 *
 * Why it is worth asking: Velixo already extracts live data from this tenant into Excel (Jed,
 * 2026-09-10), so some channel is authorised today, and an Excel reporting add-in is exactly the
 * kind of client that reads OData/GI. If this answers, the app may be able to use the same door
 * and the API entitlement need not be bought.
 *
 * This is not a retry of what was eliminated — roles, grants, tenant and scope were ruled out for
 * the REST surface. A 403 here is the same wall on a second door; a 200 is the door Velixo uses.
 *
 * Optional environment, all skipped rather than guessed when unset:
 *   MYOB_TENANT       the company/tenant segment, for the tenant-scoped URL shapes
 *   MYOB_GI           a Generic Inquiry name to pull one row from
 *   MYOB_ODATA_USER   ) Basic credentials — the shape an Excel add-in signs in with, and the
 *   MYOB_ODATA_PASS   ) likeliest reason a bearer 401s here while Velixo works. Never printed.
 */
{
  const { odataCandidates, readOdataStatus, authHeader } = await import("./myobOdata.js");
  const tenant = process.env.MYOB_TENANT || "";
  const gi = process.env.MYOB_GI || "";
  const user = process.env.MYOB_ODATA_USER || "";
  const pass = process.env.MYOB_ODATA_PASS || "";

  console.log(`\n── OData (the surface Velixo would use) ──`);
  if (!tenant) console.log("MYOB_TENANT unset — the tenant-scoped addresses are skipped, not guessed.");
  if (!gi) console.log("MYOB_GI unset — no named inquiry is probed; the service document still says what is exposed.");
  console.log(`credentials: bearer (the service token)${user && pass ? " and Basic (MYOB_ODATA_USER)" : " only — set MYOB_ODATA_USER / MYOB_ODATA_PASS to also try Basic"}`);

  let token = null;
  try {
    const { getMyobAccessToken } = await import("./myobToken.js");
    token = await getMyobAccessToken(db);
  } catch (e) {
    console.log(`(no bearer available — ${(e && e.message) || e})`);
  }

  const modes = [["bearer", { token }]];
  if (user && pass) modes.push(["basic", { user, pass }]);

  const rows = [];
  for (const [mode, creds] of modes) {
    const header = authHeader(mode, creds);
    if (!header) continue;
    for (const c of odataCandidates(cfg.instance, tenant, gi)) {
      try {
        const res = await fetch(c.url, { headers: { Authorization: header, Accept: "application/json" } });
        const { verdict, note } = readOdataStatus(res.status);
        /* A body sample only on success: it is the difference between "the endpoint answered"
           and "the endpoint answered with our data", and one is worth acting on. */
        let sample = note;
        if (res.status === 200) {
          const text = await res.text().catch(() => "");
          sample = `${text.replace(/\s+/g, " ").slice(0, 100)}…`;
        }
        rows.push([mode, c.label, `${res.status} ${verdict}`, sample]);
      } catch (e) {
        rows.push([mode, c.label, "UNREACHABLE", String((e && e.message) || e).slice(0, 90)]);
      }
    }
  }

  const w = (s, n) => String(s).padEnd(n);
  console.log("\n" + w("AUTH", 8) + w("ADDRESS", 22) + w("RESULT", 18) + "WHAT IT MEANS");
  console.log("-".repeat(110));
  for (const r of rows) console.log(w(r[0], 8) + w(r[1], 22) + w(r[2], 18) + r[3]);

  const open = rows.filter((r) => /OPEN/.test(r[2]));
  const auth = rows.filter((r) => /AUTH/.test(r[2]));
  const refused = rows.filter((r) => /REFUSED/.test(r[2]));
  console.log("");
  if (open.length) {
    console.log("FINDING: OData ANSWERS. This is very likely the channel Velixo uses, and the app can");
    console.log("read it the same way — actuals could come through without buying the REST entitlement.");
    console.log("Next: confirm with MYOB/Velixo that a second client on this channel is within licence,");
    console.log("then expose the figures the hub needs as a Generic Inquiry and read that.");
  } else if (auth.length && !refused.length) {
    console.log("FINDING: the OData surface EXISTS and rejected these credentials rather than refusing");
    console.log("the request. That is the encouraging answer — it is a credentials question, not an");
    console.log("entitlement one. Find out which user Velixo signs in as and try Basic with it");
    console.log("(MYOB_ODATA_USER / MYOB_ODATA_PASS), rather than the service token.");
  } else if (refused.length) {
    console.log("FINDING: authenticated and refused on OData too — the same wall as the REST entities,");
    console.log("on a second door. That points at a tenant-level entitlement rather than anything we");
    console.log("can configure. Worth asking MYOB directly how Velixo is authorised, since it plainly");
    console.log("is: whatever answer they give names the channel we should be using.");
  } else {
    console.log("FINDING: nothing answered. Before concluding anything, get the real OData address from");
    console.log("Velixo's connection settings — every shape here is a guess at how the tenant is");
    console.log("provisioned, and a 404 is not a rights answer.");
  }
}
