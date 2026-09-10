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
import { readInquiry, rollUpActuals, ACTUALS_INQUIRY, ACTUALS_SELECT, ACTUALS_ORDER } from "./myobOdataRead.js";
import { readOdataCreds } from "./myobOdataCreds.js";

export const TABLE = "myob_actuals";
export const CHUNK = 500;

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
    cost_code: r.cost_code,
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
} = {}) {
  const creds = given || await readOdataCreds(db, env);
  const syncedAt = now();

  const { rows, requests, sessionReused, complete } = await read({
    instance: creds.instance, tenant: creds.tenant, inquiry: ACTUALS_INQUIRY,
    user: creds.user, pass: creds.pass, select: ACTUALS_SELECT, orderBy: ACTUALS_ORDER,
  });

  const rolled = rollUpActuals(rows);
  const tableRows = toTableRows(rolled, syncedAt);

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
    read: rows.length,
    rolled: rolled.length,
    written,
    swept,
    requests,
    sessionReused,
    complete: complete === true,
    syncedAt,
    as: creds.user,
    /* Named so a summary can say it out loud: the whole point of the roll-up is that these two
       numbers differ, and a reader should see the ledger lines behind the figures. */
    ledgerRows: rolled.reduce((n, r) => n + (r.rows || 0), 0),
  };
}
