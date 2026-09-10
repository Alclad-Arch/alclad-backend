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
import { shouldRunNow } from "./syncSchedule.js";

export const TABLE = "myob_actuals";
/* The contract-and-budget half, from ALX_JobAnalysis. Written in the SAME run as the ledger so both
   reads share one Acumatica session — sessions, not requests, are what the licence counts. */
export const BUDGET_TABLE = "myob_project_budget";
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

  let budgetSwept = 0;
  /* Judged on its OWN read and its OWN write count. Gating the budget sweep on the ledger's success
     would delete a project's contract because its transactions failed to read, and vice versa —
     two feeds, two independent decisions. */
  if (shouldSweep({ complete: budgetRead.complete === true, rowsWritten: budgetWritten })) {
    const { data, error } = await db.from(BUDGET_TABLE).delete().lt("synced_at", syncedAt).select("project_id");
    if (error) throw new Error(`${BUDGET_TABLE} sweep failed: ${error.message}`);
    budgetSwept = Array.isArray(data) ? data.length : 0;
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
    requests: requests + groupRead.requests + budgetRead.requests,
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
    syncedAt,
    as: creds.user,
    /* Named so a summary can say it out loud: the whole point of the roll-up is that these two
       numbers differ, and a reader should see the ledger lines behind the figures. */
    ledgerRows: rolled.reduce((n, r) => n + (r.rows || 0), 0),
  };
}
