// What ALX_JobAnalysis ACTUALLY returns for one job. Read-only, one session, no writes.
//
//   node probe-jobanalysis.js 5477
//   node probe-jobanalysis.js 5477 6163 6157
//
// Written 2026-09-11 for a specific question. On 6163 our cost_at_completion reconciles with
// MYOB's Projected Cost at Completion to the cent, and the identity
//
//     CostAtCompletion = CostsToDate + CostProjection + OpenCommittedAmt
//
// holds exactly. On 5477 the same identity holds in our data, but CostProjection is 0.00 on both
// package rows while MYOB's screen implies NEGATIVE values (-35,190.85 on Cladding, -1,668.78 on
// Glazing, derived from its Costs to Complete less Open Committed). So either the inquiry returns
// zero where the screen computes something else, or the value never survives the wire.
//
// num() in myobJobAnalysis.js cannot be the culprit — it has no clamp and Number('-35190.85')
// parses — but Number('-35,190.85') is NaN, which becomes 0. A formatted string would do this.
// SO PRINT THE RAW VALUE AND ITS JAVASCRIPT TYPE, not a parsed number: the difference between
// the number 0, the string "0.00", the string "-35,190.85" and an absent field is the whole
// question, and every one of them reads as 0 after parsing.
//
// It asks for the SAME credentials the nightly sync uses, so:
//   $env:SUPABASE_URL, $env:SUPABASE_SERVICE_ROLE_KEY, $env:TOKEN_ENC_KEY   (prod values)
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { readOdataCreds, describeCreds } from "./myobOdataCreds.js";
import { readInquiry } from "./myobOdataRead.js";
import { BUDGET_SELECT, BUDGET_INQUIRY } from "./myobJobAnalysis.js";

/* --all drops the $select so the inquiry returns EVERY column it has, not just the ones we ask
   for. Added 2026-09-14 for a specific question — Jed: "I think this figure should be the GP% on
   which the project was won. Is that a stored figure in myob per project?" MYOB's Project Balances
   screen shows it (ORIGINAL CONTRACT → GP %), but everything in BUDGET_SELECT is the REVISED side,
   so whether the original is reachable through this inquiry is not something reading our own code
   can answer. */
const all = process.argv.includes("--all");
const jobs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!jobs.length) {
  console.error("\nGive it at least one job number:  node probe-jobanalysis.js 5477 6163\n");
  process.exit(1);
}

const need = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\nMissing: ${missing.join(", ")}\nSet them in this shell and re-run.\n`);
  process.exit(1);
}

const ref = (String(process.env.SUPABASE_URL).match(/^https:\/\/([a-z0-9]+)\./) || [])[1] || "?";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const creds = await readOdataCreds(db, process.env);
const d = describeCreds(creds);
console.log(`\nALX_JobAnalysis probe — READ ONLY, nothing is written`);
console.log(`  supabase project : ${ref}   (credentials only — no rows are read or written)`);
console.log(`  connecting as    : ${d.user} (${d.source})`);
console.log(`  tenant           : ${d.tenant}`);
console.log(`  jobs             : ${jobs.join(", ")}\n`);

/* One filter, one session, one request. A per-job loop would open a session per job, and sessions
   are what the Acumatica licence counts. */
const filter = jobs.map((j) => `Project eq '${String(j).replace(/'/g, "''")}'`).join(" or ");
const { rows, complete } = await readInquiry({
  ...creds, inquiry: BUDGET_INQUIRY, filter, orderBy: "Project",
  ...(all ? {} : { select: BUDGET_SELECT }),
});
if (!complete) console.warn("⚠ the read reported incomplete — treat what follows as partial\n");
console.log(`${rows.length} row(s)\n`);

for (const r of rows) {
  console.log("─".repeat(78));
  for (const f of (all ? Object.keys(r) : BUDGET_SELECT)) {
    const v = r[f];
    const t = v === null ? "null" : v === undefined ? "ABSENT" : typeof v;
    /* JSON.stringify so a string is visibly quoted: "0.00" and 0 print identically otherwise, and
       telling them apart is the entire point of this script. */
    console.log(`  ${f.padEnd(22)} ${String(JSON.stringify(v)).padEnd(18)} ${t}`);
  }
}
console.log("─".repeat(78));
console.log("\nNothing was written.\n");
