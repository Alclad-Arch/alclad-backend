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
import {
  rollUpJobAnalysis, BUDGET_INQUIRY, BUDGET_SELECT, BUDGET_ORDER,
} from "./myobJobAnalysis.js";
import {
  rollUpCostCodes, reconcileAgainstPackages,
  COSTCODE_INQUIRY, COSTCODE_SELECT, COSTCODE_ORDER,
} from "./myobCostCodes.js";
import {
  rollUpProjections, PROJECTION_INQUIRY, PROJECTION_SELECT, PROJECTION_ORDER,
} from "./myobCostProjections.js";

/* Whether the per-code figures sum to the per-package ones. Shared by the dry run and the real run
 * so the two cannot report it differently — the dry run exists precisely so this can be checked
 * before anything is written, and a second copy of the wording is a second thing to keep in step.
 *
 * ⚠ A DRIFT IS NOT AUTOMATICALLY A BUG. ALX_JobAnalysis floors CostProjection at 0 on an overspent
 * job where ALX_JobAnalysis_Detail does not, so an overspent job may legitimately differ — and
 * where it does, the DETAIL figure is the more faithful one. Which is why this prints the jobs
 * rather than failing the run: the list is the evidence for deciding that, and 5477 is the job to
 * look for. */
/* Does each code's NEWEST revision still agree with its current forecast?
 *
 * That agreement is what PROVED what these columns mean — 6163/1000101's newest revision forecasts
 * 12,477, exactly the cost_at_completion the per-code feed reports — so it is re-checked every run
 * rather than trusted once. A divergence means one of the two inquiries changed meaning underneath
 * us, which is the failure this whole feed has already suffered once.
 *
 * REPORTED, not enforced: a projection written before the latest budget change can legitimately
 * differ, and refusing would stop the nightly over a bookkeeping order. */
function reportProjectionAgreement(out) {
  if (out.projAgrees) {
    console.log(`  ✓ every code's newest revision matches its current cost at completion`);
    return;
  }
  console.log(`  ⚠ ${out.projDrifts.length} code(s) whose newest revision does NOT match the current forecast:`);
  for (const d of out.projDrifts) {
    console.log(`      ${d.project_id} ${d.cost_code} ${String(d.revision).padEnd(14)} projection ${d.latest_projection.toFixed(2).padStart(13)}  current ${d.cost_at_completion.toFixed(2).padStart(13)}  diff ${d.diff.toFixed(2)}`);
  }
  /* ⚠ THE FIRST PROD RUN REFRAMED THIS. 2,211 of 2,231 codes matched exactly; the 20 that did not
     were all on three jobs — 0087, 4870, 5246 — whose newest projection dates from 2025. That is
     not two inquiries disagreeing, it is ONE STALE PROJECTION, and the wording here said the
     opposite loudly enough to send someone looking for a bug.
     Why it happens: cost_at_completion is recomputed by MYOB as costs_to_date + cost_projection +
     open_committed, so it MOVES as spend moves. A projection written eighteen months ago and never
     revised is therefore left behind by it — which is precisely what the forecast-health panel
     exists to surface. */
  console.log(`  This is STALENESS, not disagreement: cost at completion tracks spend, so a`);
  console.log(`  projection nobody has revised since is left behind by it. These are the jobs`);
  console.log(`  whose forecasts have stopped being maintained.`);
  console.log(`  Worry only if a job with a RECENT projection appears here.`);
}

function reportReconciliation(out) {
  if (out.codeReconciles) {
    const n = out.compared == null ? '' : `${out.compared} `;
    console.log(`  ✓ per-code sums match the per-package figures on all ${n}package(s) compared`);
    return;
  }
  console.log(`  ⚠ ${out.codeDriftCount} package figure(s) DO NOT match the per-code sums:`);
  for (const d of out.codeDrifts) {
    console.log(`      ${d.project_id} ${d.package_type} ${d.field.padEnd(18)} per-code ${d.per_code.toFixed(2).padStart(14)}  per-package ${d.per_package.toFixed(2).padStart(14)}  diff ${d.diff.toFixed(2)}`);
  }
  if (out.codeDriftCount > out.codeDrifts.length) {
    console.log(`      … ${out.codeDriftCount - out.codeDrifts.length} more not listed`);
  }
  console.log(`  An OVERSPENT job drifting here is expected — ALX_JobAnalysis floors CostProjection`);
  console.log(`  at 0 and the _Detail inquiry does not. Anything else needs looking at before the`);
  console.log(`  bars are trusted: they would contradict the dials above them and neither would say so.`);
}

const dry = process.argv.includes("--dry-run");
/* --guard applies the same once-a-day rule the scheduler uses, read from max(synced_at) in the
   data. For a Render Cron Job that has its own schedule this is unnecessary; for a cron running
   ALONGSIDE the in-process scheduler, or a hand-run you want to be safe, it prevents a second
   Acumatica session. A bare run is never second-guessed. */
const guard = process.argv.includes("--guard");

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

    /* ── THE BUDGET AND COST-CODE FEEDS, ON THE SAME SESSION ────────────────────────────────────
     *
     * ⚠ THIS PATH USED TO STOP AT THE LEDGER, and that was a hole rather than a shortcut: a dry run
     * reported healthily while saying NOTHING about the two other inquiries a real run reads and
     * writes. Someone reading "Nothing was written" reasonably concluded the whole run was
     * understood. Cost codes were added on 2026-09-16 and the gap became obvious — the one check
     * that makes the bars trustworthy was the one the safe-to-run-against-prod path skipped.
     *
     * Both reads reuse the cookie, so a dry run still costs ONE Acumatica session. */
    const budgetRead = await readInquiry({
      instance: creds.instance, tenant: creds.tenant, inquiry: BUDGET_INQUIRY,
      user: creds.user, pass: creds.pass, select: BUDGET_SELECT, orderBy: BUDGET_ORDER,
      cookie: groupRead.cookie,
    });
    const budgetRolled = rollUpJobAnalysis(budgetRead.rows);
    console.log(`\ncontract/budget from ${BUDGET_INQUIRY}`);
    console.log(`read ${budgetRead.rows.length} row(s) → ${budgetRolled.length} project × package figure(s)`);

    const codeRead = await readInquiry({
      instance: creds.instance, tenant: creds.tenant, inquiry: COSTCODE_INQUIRY,
      user: creds.user, pass: creds.pass, select: COSTCODE_SELECT, orderBy: COSTCODE_ORDER,
      cookie: groupRead.cookie,
    });
    /* rollUpCostCodes THROWS if the inquiry's two cost-code columns disagree. Caught and REPORTED
       here rather than allowed to kill the process: seeing the problem is the whole point of a dry
       run, and a real run refusing is the correct behaviour for the same fact. */
    let codeRolled = null;
    try {
      codeRolled = rollUpCostCodes(codeRead.rows);
    } catch (err) {
      console.log(`\n⚠ ${COSTCODE_INQUIRY} — A REAL RUN WOULD REFUSE:`);
      console.log(`  ${(err && err.message) || err}`);
    }
    if (codeRolled) {
      console.log(`\ncost codes from ${COSTCODE_INQUIRY}`);
      console.log(`read ${codeRead.rows.length} row(s)${codeRead.complete ? "" : " — ⚠ INCOMPLETE, a real run would not sweep"}`);
      console.log(`rolls up to ${codeRolled.length} project × package × code figure(s)`);
      console.log(`  with a budget   : ${codeRolled.filter((r) => r.has_budget).length}`);
      console.log(`  with a forecast : ${codeRolled.filter((r) => r.has_forecast).length}`);
      console.log(`  defect codes    : ${codeRolled.filter((r) => r.is_defect).length}`);
      const recon = reconcileAgainstPackages(codeRolled, budgetRolled);
      reportReconciliation({
        codeReconciles: recon.ok, codeDrifts: recon.drifts.slice(0, 20),
        codeDriftCount: recon.drifts.length, compared: recon.compared, codeRolled: codeRolled.length,
      });
    }
    /* The fifth read, on the same session again. A dry run that covered four of five reads is how
       the silent-feed problem got past review in the first place. */
    const projRead = await readInquiry({
      instance: creds.instance, tenant: creds.tenant, inquiry: PROJECTION_INQUIRY,
      user: creds.user, pass: creds.pass, select: PROJECTION_SELECT, orderBy: PROJECTION_ORDER,
      cookie: groupRead.cookie,
    });
    const projRolled = rollUpProjections(projRead.rows);
    const revisions = new Set(projRolled.map((r) => `${r.project_id}|${r.revision}`));
    console.log(`\nforecast history from ${PROJECTION_INQUIRY}`);
    console.log(`read ${projRead.rows.length} row(s)${projRead.complete ? "" : " — ⚠ INCOMPLETE, a real run would not sweep"}`);
    console.log(`rolls up to ${projRolled.length} project × revision × code figure(s) across ${revisions.size} revision(s)`);
    console.log(`  pre-budget rows : ${projRolled.filter((r) => r.pre_budget).length}`);

    console.log("\nNothing was written. Re-run without --dry-run to sync.\n");
  } else {
    const out = await syncActuals(db, { env: process.env, guard });
    if (out.skipped) {
      /* A SKIP IS NOT A FAILURE, and must not read like one or exit non-zero — a cron wrapper that
         treats it as an error will email about a healthy feed every night. */
      console.log(`\nSKIPPED — ${out.reason}`);
      console.log(`last sync ${out.lastSyncedAt || "never"}. Re-run without --guard to force one.\n`);
      process.exit(0);
    }
    console.log(`\nread    ${out.read} ledger row(s) in ${out.requests} request(s)${out.sessionReused ? " (one session)" : ""}`);
    console.log(`rolled  ${out.rolled} figure(s) from ${out.ledgerRows} ledger line(s)`);
    console.log(`written ${out.written}`);
    console.log(`swept   ${out.swept} row(s) MYOB no longer reports`);
    /* The budget half, reported separately: one line for both would hide a feed that read nothing
       while the other worked. withCostBudget is the number worth watching as Jed populates them. */
    console.log(``);
    console.log(`contract/budget from ALX_JobAnalysis`);
    console.log(`read    ${out.budgetRead} row(s)${out.budgetComplete ? "" : " — INCOMPLETE"}`);
    console.log(`written ${out.budgetWritten} project x package figure(s)`);
    console.log(`swept   ${out.budgetSwept}`);
    console.log(`  with a contract value : ${out.withContractValue}`);
    console.log(`  with a cost budget    : ${out.withCostBudget}`);
    /* The cost-code half. Reported separately again — three feeds, three sets of numbers, so one
       that read nothing cannot hide behind another that worked. */
    console.log(``);
    console.log(`cost codes from ${COSTCODE_INQUIRY}`);
    console.log(`read    ${out.codeRead} row(s)${out.codeComplete ? "" : " — INCOMPLETE"}`);
    console.log(`rolled  ${out.codeRolled} project x package x code figure(s)`);
    console.log(`written ${out.codeWritten}`);
    console.log(`swept   ${out.codeSwept}`);
    console.log(`  with a budget   : ${out.codesWithBudget}`);
    console.log(`  with a forecast : ${out.codesWithForecast}`);
    console.log(`  defect codes    : ${out.codeDefects}`);
    /* ⚠ SAID OUT LOUD EVERY RUN, pass or fail. A reconciliation nobody reads is one that reports a
       break the day after the bars started lying. */
    reportReconciliation(out);
    /* ⚠ THE FIFTH FEED PRINTS TOO. It was added to syncActuals' return and NOT to this report, so
       its first prod run wrote tens of thousands of rows in total silence — the exact failure every
       other block here carries a comment about. A feed that reports nothing cannot be told from one
       that read nothing. */
    console.log(``);
    console.log(`forecast history from ${PROJECTION_INQUIRY}`);
    console.log(`read    ${out.projRead} row(s)${out.projComplete ? "" : " — INCOMPLETE"}`);
    console.log(`rolled  ${out.projRolled} project x revision x code figure(s)`);
    console.log(`written ${out.projWritten}`);
    console.log(`swept   ${out.projSwept}`);
    console.log(`  revisions       : ${out.projRevisions}`);
    console.log(`  pre-budget rows : ${out.projPreBudget}`);
    reportProjectionAgreement(out);
    /* ⚠ THE SIXTH FEED. This was missed TWICE — once for the forecast history and again for this
       one, in the same session, after a note had been written saying "adding a feed means adding
       its report line in the same change". Discipline did not work; syncMyobActuals.test.js now
       asserts this file mentions every feed's written-count, so a seventh cannot be added silently. */
    console.log(``);
    console.log(`transaction detail from ${ACTUALS_INQUIRY} (same read, no extra request)`);
    console.log(`written ${out.ledgerWritten} ledger line(s)`);
    console.log(`swept   ${out.ledgerSwept}`);
    for (const [src, n] of Object.entries(out.ledgerBySource || {}).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(src).padEnd(9)} ${String(n).padStart(7)}`);
    }
    /* THE HONEST CEILING ON THE DRILL-DOWN: how much of the ledger can be traced to a supplier's
       own invoice at all. Receipts and timecards never can, and that is a fact about the document
       trail rather than missing data. */
    console.log(`  with a supplier invoice number : ${out.ledgerWithInvoice}`);
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
