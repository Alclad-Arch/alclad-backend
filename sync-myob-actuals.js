// Refresh public.myob_actuals from MYOB. One run = one nightly sync.
//
//   node sync-myob-actuals.js            read, write, sweep
//   node sync-myob-actuals.js --dry-run  read and report, write nothing
//
// ONE SESSION, ONCE A DAY. A Basic-auth request creates an Acumatica session, and sessions — not
// requests — are what the licence counts; a loop that authenticates per call can exhaust the
// concurrent-session slots and lock real people out of MYOB. The reader carries the session cookie
// across the pages of a run so the whole sync costs one, and this is meant to be scheduled nightly
// rather than polled. Being frugal here is also what makes the licence conversation easy: one
// session, once a day, as a licensed user, reading the same inquiries Velixo reads.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { syncActuals } from "./syncMyobActuals.js";
import { readOdataCreds, describeCreds } from "./myobOdataCreds.js";
import {
  readInquiry, rollUpActuals, groupTotals, classifyGroups, unknownGroups,
  ACTUALS_INQUIRY, ACTUALS_SELECT, ACTUALS_ORDER, GROUPS_INQUIRY, GROUPS_SELECT,
} from "./myobOdataRead.js";

const dry = process.argv.includes("--dry-run");

const need = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\nMissing: ${missing.join(", ")}\nSet them in this shell (or .env) and re-run.\n`);
  process.exit(1);
}

const ref = (String(process.env.SUPABASE_URL).match(/^https:\/\/([a-z0-9]+)\./) || [])[1] || "?";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

try {
  const creds = await readOdataCreds(db, process.env);
  const d = describeCreds(creds);
  console.log(`\nMYOB actuals sync${dry ? " — DRY RUN, nothing will be written" : ""}`);
  console.log(`  supabase project : ${ref}`);
  console.log(`  connecting as    : ${d.user} (${d.source})`);
  console.log(`  tenant           : ${d.tenant}`);
  console.log(`  inquiry          : ${ACTUALS_INQUIRY}`);
  if (creds.seeded) {
    console.log("  ⚠ credential came from the ENVIRONMENT, not the stored row — run set-myob-odata.js");
  }

  if (dry) {
    /* The read, the roll-up, and what WOULD be written — with no writes and no sweep, so this is
       safe to run against prod while deciding whether the figures look right. */
    /* Classification first, and the cookie threaded into the ledger read, so a dry run costs the
       same ONE Acumatica session a real run does. */
    const groupRead = await readInquiry({
      instance: creds.instance, tenant: creds.tenant, inquiry: GROUPS_INQUIRY,
      user: creds.user, pass: creds.pass, select: GROUPS_SELECT,
    });
    const { byCode, cost: costGroups, income } = classifyGroups(groupRead.rows);
    console.log(`\ncost groups   : ${[...costGroups].sort().join(", ") || "(none — a real run would refuse)"}`);
    console.log(`income groups : ${[...income].sort().join(", ") || "(none)"}   ← excluded`);

    const { rows, requests, sessionReused, complete } = await readInquiry({
      instance: creds.instance, tenant: creds.tenant, inquiry: ACTUALS_INQUIRY,
      user: creds.user, pass: creds.pass, select: ACTUALS_SELECT, orderBy: ACTUALS_ORDER,
      cookie: groupRead.cookie,
    });
    /* Reported rather than thrown, because the whole point of a dry run is to SEE the problem. */
    const strays = unknownGroups(rows, byCode);
    if (strays.length) {
      console.log(`\n⚠ the ledger carries group(s) ${GROUPS_INQUIRY} does not classify: ${strays.join(", ")}`);
      console.log("  A real run would REFUSE — an unclassified group is either revenue that would");
      console.log("  corrupt the totals or cost that would be missing from them.");
    }
    const rolled = rollUpActuals(rows, { costGroups });
    const projects = new Set(rolled.map((r) => r.project_id));
    console.log(`\nread ${rows.length} ledger row(s) in ${requests} request(s)${sessionReused ? " (one session)" : ""}`);
    console.log(`rolls up to ${rolled.length} figure(s) across ${projects.size} project(s)`);
    /* DID THE READ FINISH? Said out loud, because a truncated read is the one state where the
       figures below look ordinary and the sync must not sweep. */
    if (!complete) {
      console.log("\n⚠ the read STOPPED EARLY (row cap reached, not the end of the inquiry).");
      console.log("  A real run would write these rows and refuse to sweep. Raise maxRows first.");
    }
    /* WHICH GROUPS MAKE UP THE MONEY. The first attempt's 10.7M-per-project figures were income and
       cost summed together, and one number per project could never have shown that. Named groups
       (STAFF, MATERIAL, …) can be recognised or challenged before anything is written. */
    const groups = groupTotals(rows);
    console.log(`\nby account group — COST is what gets stored, income is excluded:`);
    let costTotal = 0;
    let incomeTotal = 0;
    for (const g of groups) {
      const kind = costGroups.has(g.account_group) ? "cost"
        : income.has(g.account_group) ? "INCOME — excluded" : "unclassified";
      if (kind === "cost") costTotal += g.amount; else if (income.has(g.account_group)) incomeTotal += g.amount;
      console.log(`  ${g.account_group.padEnd(12)} ${g.amount.toFixed(2).padStart(16)}  ${String(g.rows).padStart(6)} row(s)  ${kind}`);
    }
    console.log(`\n  cost to be stored   ${costTotal.toFixed(2).padStart(16)}`);
    console.log(`  income excluded     ${incomeTotal.toFixed(2).padStart(16)}`);
    /* A handful of projects by spend, so the figures can be eyeballed against MYOB before this is
       trusted. Deliberately a sample: the point is to sanity-check, not to reproduce the ledger. */
    const byProject = new Map();
    for (const r of rolled) byProject.set(r.project_id, (byProject.get(r.project_id) || 0) + r.actual_amount);
    const top = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`\nlargest by actual cost — check a couple against the Projects screen in MYOB`);
    console.log(`(the figure to match is ACTUAL EXPENSES, not Actual Cost minus income):`);
    for (const [p, amt] of top) console.log(`  ${p.padEnd(12)} ${amt.toFixed(2)}`);
    console.log("\nNothing was written. Re-run without --dry-run to sync.\n");
  } else {
    const out = await syncActuals(db, { env: process.env });
    console.log(`\nread    ${out.read} ledger row(s) in ${out.requests} request(s)${out.sessionReused ? " (one session)" : ""}`);
    console.log(`rolled  ${out.rolled} figure(s) from ${out.ledgerRows} ledger line(s)`);
    console.log(`written ${out.written}`);
    console.log(`swept   ${out.swept} row(s) MYOB no longer reports`);
    console.log(`stamped ${out.syncedAt}\n`);
  }
} catch (e) {
  /* Named loudly, because the failure this most needs to survive is a password change on the
     account it borrows — and the whole point of the health panel is that such a failure is not
     silent for days, the way the Salesforce one was. */
  console.error(`\nSYNC FAILED: ${(e && e.message) || e}`);
  if (e && e.status === 401) {
    console.error("401 — the credential was rejected. If the account's password changed, re-run");
    console.error("set-myob-odata.js with the new one (or point it at a dedicated integration user).");
  }
  if (e && e.status === 403) {
    console.error("403 — authenticated but refused. Acumatica restricts Generic Inquiries per role,");
    console.error("so this is likely an access right on that inquiry rather than the tenant.");
  }
  console.error("");
  process.exit(1);
}
