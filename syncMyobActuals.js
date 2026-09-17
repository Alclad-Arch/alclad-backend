// Turn a read of the MYOB actuals inquiry into rows in public.myob_actuals.
//
// Kept separate from the script that runs it so the two things that can go wrong quietly are
// testable without a live tenant or a live database:
//
//   1 · THE SWEEP. A full refresh has to remove what MYOB no longer reports — a cost reversed or
//       re-coded in the ERP must disappear here too, or the hub shows a charge the ledger does
//       not. Deleting by "not touched in this run" is how that happens, and it is also how a
//       half-finished run could delete everything it had not reached yet. Hence: the sweep only
//       runs after a COMPLETE read, and never when the read returned nothing.
//
//   2 · THE CHUNKING. A few thousand rows in one upsert is a request that can time out and leave
//       the table half-written with the sweep still to come. Chunked, and the sweep is gated on
//       every chunk having landed.
//
// The read itself is in myobOdataRead.js; the credential in myobOdataCreds.js.
import {
  readInquiry, rollUpActuals, classifyGroups, unknownGroups,
  ACTUALS_INQUIRY, ACTUALS_SELECT, ACTUALS_ORDER, GROUPS_INQUIRY, GROUPS_SELECT,
} from "./myobOdataRead.js";
import { readOdataCreds } from "./myobOdataCreds.js";
import {
  rollUpJobAnalysis, BUDGET_INQUIRY, BUDGET_SELECT, BUDGET_ORDER, BUDGET_NUMERIC,
} from "./myobJobAnalysis.js";
import {
  rollUpCostCodes, reconcileAgainstPackages,
  COSTCODE_INQUIRY, COSTCODE_SELECT, COSTCODE_ORDER, COSTCODE_NUMERIC,
} from "./myobCostCodes.js";
import {
  rollUpProjections, PROJECTION_INQUIRY, PROJECTION_SELECT, PROJECTION_ORDER,
} from "./myobCostProjections.js";
import { toLedgerLines } from "./myobLedgerLines.js";
import { shouldRunNow } from "./syncSchedule.js";

export const TABLE = "myob_actuals";
/* The contract-and-budget half, from ALX_JobAnalysis. Written in the SAME run as the ledger so both
   reads share one Acumatica session — sessions, not requests, are what the licence counts. */
export const BUDGET_TABLE = "myob_project_budget";
/* The same money broken down to the cost code, from ALX_JobAnalysis_Detail — what the hub's
   cost-code bars read. Fourth read, same session, for the same licence reason. */
export const COSTCODE_TABLE = "myob_cost_budget";
/* Forecast HISTORY per cost code. The biggest of these tables by row count — every revision of
   every code of every job — and it only grows, so nothing loads it whole. */
export const PROJECTION_TABLE = "myob_cost_projection";
/* The ledger at TRANSACTION grain — the drill-down behind a cost-code bar. Built from the SAME read
   as myob_actuals, so it costs no extra request and no extra session. */
export const LEDGER_TABLE = "myob_ledger_line";
export const CHUNK = 500;

/* When did the last successful sync finish? max(synced_at) — every run stamps every row it writes,
 * so the data records its own freshness and no separate bookkeeping can drift from it.
 *
 * Ordering by synced_at descending and taking one row rather than an aggregate: PostgREST has no
 * clean max(), and with an index on synced_at this is a single row read. Returns null for an empty
 * table, which the caller must read as "never synced" and NOT as an error. */
export async function lastSyncedAt(db) {
  const { data, error } = await db.from(TABLE)
    .select("synced_at").order("synced_at", { ascending: false }).limit(1);
  if (error) throw new Error(`could not read the last sync time: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : null;
  return row ? row.synced_at : null;
}

/* Split for upserting. Exported because the boundary conditions (an exact multiple, a single row,
   nothing at all) are where an off-by-one silently drops the last chunk. */
export function chunk(rows, size = CHUNK) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/* Should the sweep run? Two guards, both of which have a real failure behind them.
 *
 * A read that returned NO rows is indistinguishable from an inquiry that has been renamed, a
 * permission withdrawn, or a filter typo — and sweeping on it would delete every actual in the
 * hub. An incomplete read is worse: it deletes precisely the projects it did not get to.
 *
 * So: sweep only after a complete read that produced something. The cost of not sweeping is a
 * stale row for a day; the cost of sweeping wrongly is the hub silently reporting zero cost on
 * every job. */
export function shouldSweep({ complete, rowsWritten }) {
  return !!complete && rowsWritten > 0;
}

/* Rows as the table wants them, stamped with this run's timestamp so the sweep can tell what it
   touched. The roll-up has already trimmed and summed; this only adds the bookkeeping. */
export function toTableRows(rolled, syncedAt) {
  return rolled.map((r) => ({
    project_id: r.project_id,
    project_name: r.project_name || '',
    cost_code: r.cost_code,
    /* Actual revenue INVOICED against the job, positive. Not the contract value, and not the same
       thing as the hub's own sell figure — see the migration note. */
    income_amount: r.income_amount || 0,
    account_group: r.account_group,
    fin_period: r.fin_period,
    actual_amount: r.actual_amount,
    actual_qty: r.actual_qty,
    source_rows: r.rows,
    synced_at: syncedAt,
  }));
}

/* One full refresh. Returns a report rather than logging, so the caller decides what to say and a
   test can assert on it. */
export async function syncActuals(db, {
  env = process.env,
  read = readInquiry,
  creds: given = null,
  now = () => new Date().toISOString(),
  /* THE DAILY GUARD. Default OFF so a deliberate run — someone at a terminal, a Render cron job on
     a schedule of its own — is never silently skipped. Anything that fires REPEATEDLY passes true,
     and then the decision comes from max(synced_at) in the data rather than from that caller's
     memory of whether it has run.

     It lives here, not in the scheduler, because a guard in the scheduler protects only that
     scheduler: a second web-service instance, a redeploy, or a hand-run alongside a cron would each
     open another Acumatica session, and sessions are what the licence counts. */
  guard = false,
  minHours = undefined,
} = {}) {
  if (guard) {
    const last = await lastSyncedAt(db);
    const verdict = shouldRunNow({ lastSyncedAt: last, ...(minHours != null ? { minHours } : {}) });
    if (!verdict.run) {
      /* A SKIP IS A RESULT, not a failure — reported in the same shape so a caller does not have to
         tell an exception from a decision. */
      return {
        skipped: true, reason: verdict.reason, lastSyncedAt: last,
        read: 0, rolled: 0, written: 0, swept: 0, requests: 0, complete: null,
      };
    }
  }
  const creds = given || await readOdataCreds(db, env);
  const syncedAt = now();

  /* WHICH GROUPS ARE COST — read first, because without it there is nothing safe to store. Alclad
     books revenue through account groups named after the packages (GLAZING, CLADDING, RECLAD,
     FINS) and cost through groups named by category; summed together the first dry run reported
     10.7M on one project. The cookie is threaded into the second read so both cost ONE session. */
  const groupRead = await read({
    instance: creds.instance, tenant: creds.tenant, inquiry: GROUPS_INQUIRY,
    user: creds.user, pass: creds.pass, select: GROUPS_SELECT,
  });
  const { byCode, cost: costGroups, income } = classifyGroups(groupRead.rows);
  /* REFUSE RATHER THAN GUESS. No cost groups means the inquiry was renamed, a permission was
     withdrawn, or the Type column changed — and the two fallbacks are both wrong: storing every
     group files revenue as cost, storing none empties the hub. Stale for a day is the only
     acceptable failure here, and throwing before any write is what delivers it. */
  if (!costGroups.size) {
    throw new Error(`${GROUPS_INQUIRY} yielded no Expense groups (${groupRead.rows.length} row(s) read) — refusing to sync`);
  }

  const { rows, requests, sessionReused, complete } = await read({
    instance: creds.instance, tenant: creds.tenant, inquiry: ACTUALS_INQUIRY,
    user: creds.user, pass: creds.pass, select: ACTUALS_SELECT, orderBy: ACTUALS_ORDER,
    cookie: groupRead.cookie,
  });

  /* A GROUP THE CLASSIFICATION HAS NEVER HEARD OF. Both reads come from the same tenant, so this
     should be impossible; if it happens the group is either new income (which would corrupt every
     total it touches) or new cost (which would be missing from them), and nothing here can tell
     which. Refuse, and say which group. */
  const strays = unknownGroups(rows, byCode);
  if (strays.length) {
    throw new Error(`ledger carries account group(s) not in ${GROUPS_INQUIRY}: ${strays.join(", ")} — refusing to sync`);
  }

  const rolled = rollUpActuals(rows, { costGroups, incomeGroups: income });
  const tableRows = toTableRows(rolled, syncedAt);
  /* ⚠ THE SAME ROWS, KEPT ONE-FOR-ONE. rollUpActuals summarises them to project × code × period;
     this keeps every transaction so a red bar can be opened. Both from one read — the drill-down
     costs nothing but the columns already in ACTUALS_SELECT.
     toLedgerLines REFUSES on a duplicate TranID, which would mean paging repeated a row — and that
     would have double-counted the figures above it too, silently. */
  const ledgerLines = toLedgerLines(rows, syncedAt, { costGroups });

  /* ── THE CONTRACT AND BUDGET READ ─────────────────────────────────────────────────────────────
   *
   * Third read, same session. ALX_JobAnalysis is small — one row per project × cost bucket, not per
   * transaction — so this costs one request, not a hundred.
   *
   * Its grain is the subtle part: revenue and cost figures sit on DIFFERENT rows and which side a
   * row belongs to depends on its AccountGroupID, so the same tenant classification used above is
   * passed straight in. ContractValueIncVar is NOT summable across both sides — see
   * myobJobAnalysis.js. */
  const budgetRead = await read({
    instance: creds.instance, tenant: creds.tenant, inquiry: BUDGET_INQUIRY,
    user: creds.user, pass: creds.pass, select: BUDGET_SELECT, orderBy: BUDGET_ORDER,
    cookie: groupRead.cookie,
  });
  /* NO CLASSIFICATION. Every figure in this inquiry is additive and belongs to the row it sits on,
     whatever that row AccountGroupID says: job 6931 carries its 69,110 contract value on a SUBCONT
     row. An earlier version split the columns by account-group side and discarded the contract value
     of 160 of 165 jobs for it. */
  const budgetRolled = rollUpJobAnalysis(budgetRead.rows);
  const budgetTableRows = budgetRolled.map((r) => ({
    project_id: r.project_id,
    package_type: r.package_type,
    package_scope: r.package_scope,
    project_name: r.project_name,
    project_manager: r.project_manager,
    stage: r.stage,
    ...Object.fromEntries(BUDGET_NUMERIC.map((f) => [f, r[f]])),
    source_rows: r.source_rows,
    synced_at: syncedAt,
  }));

  /* ── THE COST-CODE READ ───────────────────────────────────────────────────────────────────────
   *
   * Fourth read, same session. ALX_JobAnalysis_Detail is the `_Detail` sibling of the inquiry read
   * just above — the identical money, broken down to project × task × account group × cost code.
   *
   * ⚠ IT IS SUBSTANTIALLY BIGGER than the package inquiry (thousands of rows, not ~171), so it
   * pages. That is exactly why COSTCODE_ORDER exists: an unordered $skip page can repeat one row
   * and drop another, and the total then comes up quietly short.
   *
   * rollUpCostCodes THROWS if the inquiry's two cost-code columns ever disagree. That is
   * deliberate and it is not a network failure: it means the inquiry's join has changed underneath
   * us and a whole package's budget would otherwise land on one arbitrary code, looking entirely
   * plausible on screen. Better a loud nightly failure than a wrong bar. */
  const codeRead = await read({
    instance: creds.instance, tenant: creds.tenant, inquiry: COSTCODE_INQUIRY,
    user: creds.user, pass: creds.pass, select: COSTCODE_SELECT, orderBy: COSTCODE_ORDER,
    cookie: groupRead.cookie,
  });
  const codeRolled = rollUpCostCodes(codeRead.rows);
  const codeTableRows = codeRolled.map((r) => ({
    project_id: r.project_id,
    package_type: r.package_type,
    cost_code: r.cost_code,
    cost_code_dashed: r.cost_code_dashed,
    cost_code_desc: r.cost_code_desc,
    account_group: r.account_group,
    project_task: r.project_task,
    is_defect: r.is_defect,
    ...Object.fromEntries(COSTCODE_NUMERIC.map((f) => [f, r[f]])),
    has_budget: r.has_budget,
    has_forecast: r.has_forecast,
    source_rows: r.source_rows,
    synced_at: syncedAt,
  }));

  /* ⚠ THE CHECK THAT MAKES THE BARS TRUSTWORTHY, run on the two reads this run just did rather
     than against any stored constant. Per-code figures MUST sum to what the package inquiry reports
     for the same job, or bars would contradict the dials directly above them on the same screen
     and neither would say so.
     REPORTED, NOT ENFORCED — see the overspent-job note in myobCostCodes.js: ALX_JobAnalysis floors
     CostProjection at 0 where the _Detail inquiry does not, so an overspent job MAY legitimately
     drift, and that would be the detail feed being more faithful rather than wrong. Refusing on it
     would stop the nightly run over a known MYOB quirk; hiding it would be worse. */
  const codeRecon = reconcileAgainstPackages(codeRolled, budgetRolled);

  /* ── THE FORECAST-HISTORY READ ────────────────────────────────────────────────────────────────
   *
   * Fifth read, same session. Every revision of every cost code of every job, so this is the
   * LARGEST of the five by row count and the one that pages most — which is exactly why
   * PROJECTION_ORDER is project + revision + line: an unordered $skip page can repeat one row and
   * drop another, and over tens of thousands of rows the total comes up quietly short.
   *
   * ⚠ NO PERMISSION WAS NEEDED FOR THIS. ALX_PMCostProjectionLines returns 403 and a request to
   * have it shared was drafted twice; this inquiry was already readable and carries more. */
  const projRead = await read({
    instance: creds.instance, tenant: creds.tenant, inquiry: PROJECTION_INQUIRY,
    user: creds.user, pass: creds.pass, select: PROJECTION_SELECT, orderBy: PROJECTION_ORDER,
    cookie: groupRead.cookie,
  });
  const projRolled = rollUpProjections(projRead.rows);
  const projTableRows = projRolled.map((r) => ({
    project_id: r.project_id,
    revision: r.revision,
    cost_code: r.cost_code,
    cost_code_dashed: r.cost_code_dashed,
    cost_code_desc: r.cost_code_desc,
    package_type: r.package_type,
    is_defect: r.is_defect,
    account_group: r.account_group,
    project_task: r.project_task,
    forecast: r.forecast,
    to_complete: r.to_complete,
    variance: r.variance,
    spend_at: r.spend_at,
    completed_pct: r.completed_pct,
    pre_budget: r.pre_budget,
    lines: r.lines,
    revised_at: r.revised_at,
    synced_at: syncedAt,
  }));

  /* ⚠ THE LATEST REVISION MUST AGREE WITH THE CURRENT FORECAST, and that is what proved the column
     semantics in the first place: 6163/1000101's newest revision forecasts 12,477, which is exactly
     the cost_at_completion the per-code feed reports. Checked every run rather than trusted once,
     because the day they diverge is the day one of the two inquiries changed meaning underneath us.
     REPORTED, not enforced — a job whose projection was written before its latest budget change can
     legitimately differ, and refusing would stop the nightly over a bookkeeping order. */
  const latestByCode = new Map();
  for (const r of projRolled) {
    if (r.pre_budget) continue;
    const k = `${r.project_id}|${r.package_type}|${r.cost_code}`;
    const cur = latestByCode.get(k);
    if (!cur || String(r.revised_at || '') > String(cur.revised_at || '')) latestByCode.set(k, r);
  }
  const projDrifts = [];
  for (const c of codeRolled) {
    if (!c.has_forecast) continue;
    const hit = latestByCode.get(`${c.project_id}|${c.package_type}|${c.cost_code}`);
    if (!hit) continue;
    const d = Math.round((Number(hit.forecast) - Number(c.cost_at_completion)) * 100) / 100;
    if (Math.abs(d) > 0.005 && projDrifts.length < 20) {
      projDrifts.push({ project_id: c.project_id, cost_code: c.cost_code, revision: hit.revision,
                        latest_projection: hit.forecast, cost_at_completion: c.cost_at_completion, diff: d });
    }
  }

  let written = 0;
  for (const part of chunk(tableRows)) {
    const { error } = await db.from(TABLE).upsert(part, { onConflict: "project_id,cost_code,fin_period" });
    /* Stop on the first failure and DO NOT sweep. A partial write plus a sweep is the one
       combination that loses data rather than merely delaying it. */
    if (error) {
      const e = new Error(`${TABLE} upsert failed after ${written} row(s): ${error.message}`);
      e.written = written;
      throw e;
    }
    written += part.length;
  }

  /* The budget table, on its own grain. Written after the ledger so a failure here leaves the
     actuals intact and correct rather than the pair half-updated in an unknown combination. */
  let budgetWritten = 0;
  for (const part of chunk(budgetTableRows)) {
    const { error } = await db.from(BUDGET_TABLE).upsert(part, { onConflict: "project_id,package_type" });
    if (error) {
      const e = new Error(`${BUDGET_TABLE} upsert failed after ${budgetWritten} row(s): ${error.message}`);
      e.written = budgetWritten;
      throw e;
    }
    budgetWritten += part.length;
  }

  /* The cost-code table, written after the package table for the same reason that one is written
     after the ledger: a failure here leaves the coarser figures intact and correct rather than the
     set half-updated in an unknown combination. The hub degrades to package-level dials, which is
     exactly what it showed before these bars existed. */
  let codeWritten = 0;
  for (const part of chunk(codeTableRows)) {
    const { error } = await db.from(COSTCODE_TABLE).upsert(part, { onConflict: "project_id,package_type,cost_code" });
    if (error) {
      const e = new Error(`${COSTCODE_TABLE} upsert failed after ${codeWritten} row(s): ${error.message}`);
      e.written = codeWritten;
      throw e;
    }
    codeWritten += part.length;
  }

  let budgetSwept = 0;
  /* Judged on its OWN read and its OWN write count. Gating the budget sweep on the ledger's success
     would delete a project's contract because its transactions failed to read, and vice versa —
     two feeds, two independent decisions. */
  if (shouldSweep({ complete: budgetRead.complete === true, rowsWritten: budgetWritten })) {
    const { data, error } = await db.from(BUDGET_TABLE).delete().lt("synced_at", syncedAt).select("project_id");
    if (error) throw new Error(`${BUDGET_TABLE} sweep failed: ${error.message}`);
    budgetSwept = Array.isArray(data) ? data.length : 0;
  }

  /* Written last of the five: a failure here leaves every current figure intact and costs only the
     history panel, which is the least load-bearing thing the hub shows. */
  let projWritten = 0;
  for (const part of chunk(projTableRows)) {
    const { error } = await db.from(PROJECTION_TABLE).upsert(part, { onConflict: "project_id,revision,cost_code" });
    if (error) {
      const e = new Error(`${PROJECTION_TABLE} upsert failed after ${projWritten} row(s): ${error.message}`);
      e.written = projWritten;
      throw e;
    }
    projWritten += part.length;
  }

  let codeSwept = 0;
  /* Its own read, its own write count — a third independent decision. This feed pages, so a
     truncated read is a live possibility here in a way it is not for the ~171-row package inquiry,
     and sweeping after one would delete every code the read never reached. */
  if (shouldSweep({ complete: codeRead.complete === true, rowsWritten: codeWritten })) {
    const { data, error } = await db.from(COSTCODE_TABLE).delete().lt("synced_at", syncedAt).select("project_id");
    if (error) throw new Error(`${COSTCODE_TABLE} sweep failed: ${error.message}`);
    codeSwept = Array.isArray(data) ? data.length : 0;
  }

  /* The transaction detail. Written after the figures it explains, so a failure here costs the
     drill-down and leaves every total intact. */
  let ledgerWritten = 0;
  for (const part of chunk(ledgerLines)) {
    const { error } = await db.from(LEDGER_TABLE).upsert(part, { onConflict: "project_id,tran_id" });
    if (error) {
      const e = new Error(`${LEDGER_TABLE} upsert failed after ${ledgerWritten} row(s): ${error.message}`);
      e.written = ledgerWritten;
      throw e;
    }
    ledgerWritten += part.length;
  }

  let ledgerSwept = 0;
  /* Judged on THE LEDGER READ — the same read myob_actuals is judged on, because they are the same
     rows. A transaction reversed or re-coded in MYOB has to disappear from both. */
  if (shouldSweep({ complete: complete === true, rowsWritten: ledgerWritten })) {
    const { data, error } = await db.from(LEDGER_TABLE).delete().lt("synced_at", syncedAt).select("project_id");
    if (error) throw new Error(`${LEDGER_TABLE} sweep failed: ${error.message}`);
    ledgerSwept = Array.isArray(data) ? data.length : 0;
  }

  let projSwept = 0;
  /* Its own read, its own count — the fifth independent decision. This feed pages the most of the
     five, so a truncated read is likeliest here, and sweeping after one would delete the history of
     every job the read never reached. */
  if (shouldSweep({ complete: projRead.complete === true, rowsWritten: projWritten })) {
    const { data, error } = await db.from(PROJECTION_TABLE).delete().lt("synced_at", syncedAt).select("project_id");
    if (error) throw new Error(`${PROJECTION_TABLE} sweep failed: ${error.message}`);
    projSwept = Array.isArray(data) ? data.length : 0;
  }

  let swept = 0;
  /* COMPLETE COMES FROM THE READ, NOT FROM HOPE. This was `complete: true`, which made the guard
     above unreachable: a read truncated at maxRows would have swept the projects it never reached.
     Required to be exactly true, so a reader that does not report completeness leaves rows stale
     for a day rather than deleting them. */
  if (shouldSweep({ complete: complete === true, rowsWritten: written })) {
    const { data, error } = await db.from(TABLE).delete().lt("synced_at", syncedAt).select("project_id");
    if (error) throw new Error(`${TABLE} sweep failed: ${error.message}`);
    swept = Array.isArray(data) ? data.length : 0;
  }

  return {
    skipped: false,
    read: rows.length,
    rolled: rolled.length,
    written,
    swept,
    requests: requests + groupRead.requests + budgetRead.requests + codeRead.requests + projRead.requests,
    sessionReused,
    complete: complete === true,
    /* Said out loud in the report, because "which groups counted as cost" is the question behind
       every figure here and the answer now comes from the tenant rather than this file. */
    costGroups: [...costGroups].sort(),
    incomeGroups: [...income].sort(),
    /* The budget half, reported separately — one number for both would hide a feed that read
       nothing while the other worked. */
    budgetRead: budgetRead.rows.length,
    budgetWritten,
    budgetSwept,
    budgetComplete: budgetRead.complete === true,
    withContractValue: budgetRolled.filter((r) => r.contract_value !== 0).length,
    withCostBudget: budgetRolled.filter((r) => r.budget_cost !== 0).length,
    /* The cost-code half, reported separately again — three feeds, three sets of numbers, so one
       that read nothing cannot hide behind another that worked. */
    codeRead: codeRead.rows.length,
    codeRolled: codeRolled.length,
    codeWritten,
    codeSwept,
    codeComplete: codeRead.complete === true,
    codesWithBudget: codeRolled.filter((r) => r.has_budget).length,
    codesWithForecast: codeRolled.filter((r) => r.has_forecast).length,
    codeDefects: codeRolled.filter((r) => r.is_defect).length,
    /* ⚠ SAID OUT LOUD EVERY RUN. A silent reconciliation is one nobody reads until the bars are
       already wrong; the drift list is capped so a systemic break reports its scale rather than
       printing thousands of lines. */
    codeReconciles: codeRecon.ok,
    codeDrifts: codeRecon.drifts.slice(0, 20),
    codeDriftCount: codeRecon.drifts.length,
    codeUnmatched: codeRecon.unmatched.length,
    /* The forecast-history half — fourth set of numbers, reported separately for the same reason as
       the other three: a feed that read nothing must not hide behind one that worked. */
    projRead: projRead.rows.length,
    projRolled: projRolled.length,
    projWritten,
    projSwept,
    projComplete: projRead.complete === true,
    projRevisions: new Set(projRolled.map((r) => `${r.project_id}|${r.revision}`)).size,
    projPreBudget: projRolled.filter((r) => r.pre_budget).length,
    /* ⚠ Does the newest revision still agree with the current forecast? That agreement is what
       proved what these columns MEAN, so it is checked every run rather than trusted once. */
    projAgrees: projDrifts.length === 0,
    projDrifts,
    /* The transaction detail — fifth set of numbers, reported separately like the rest. The counts
       by source are the useful part: they say how much of the ledger can be traced to a supplier
       invoice at all, which is the honest limit of the drill-down. */
    ledgerWritten,
    ledgerSwept,
    ledgerBySource: ledgerLines.reduce((acc, l) => { acc[l.source] = (acc[l.source] || 0) + 1; return acc; }, {}),
    ledgerWithInvoice: ledgerLines.filter((l) => !!l.supplier_inv_nbr).length,
    /* ⚠ How many lines are COST. The rest are revenue, and a breakdown that sums them together
       reports cost netted against income — the failure this feed hit on its very first dry run. */
    ledgerCostLines: ledgerLines.filter((l) => l.is_cost).length,
    /* How many package figures the reconciliation actually checked. Without it the report reads
       "matched on all package(s)" — which is equally true of having compared none. */
    compared: codeRecon.compared,
    syncedAt,
    as: creds.user,
    /* Named so a summary can say it out loud: the whole point of the roll-up is that these two
       numbers differ, and a reader should see the ledger lines behind the figures. */
    ledgerRows: rolled.reduce((n, r) => n + (r.rows || 0), 0),
  };
}
