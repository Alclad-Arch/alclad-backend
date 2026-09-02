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
import { myobGet, myobConfig } from "./myobToken.js";

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

if (ok < results.length) {
  console.log("\nA 403 naming a form is an access-rights gap, not a broken connection: open that");
  console.log("screen in Acumatica, Tools -> Access Rights, give the role View Only, and re-run.");
  console.log("Re-running is free now — the rotated refresh token is stored, not printed.\n");
} else {
  console.log("\nEverything the integration needs is readable.\n");
}

// Show the rotation counter: it proves the storage path is actually being written, which is
// the half of this that has no other visible symptom until it fails.
const { data } = await db.from("integration_tokens").select("rotated_count, updated_at").eq("provider", "myob").maybeSingle();
if (data) console.log(`refresh token rotated ${data.rotated_count} time(s), last written ${data.updated_at}\n`);
