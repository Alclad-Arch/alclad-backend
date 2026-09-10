// The actuals sync.
//
// The dangerous half is the SWEEP. A full refresh must delete what MYOB no longer reports — a cost
// reversed or re-coded in the ERP has to disappear here too, or the hub shows a charge the ledger
// does not. But the same delete, run after a read that failed or returned nothing, wipes every
// actual in the hub and leaves every job reading zero cost. Which looks exactly like a quiet month.
//
// So these tests are mostly about when the sweep must NOT happen.
import assert from "node:assert/strict";
import test from "node:test";
import { syncActuals, chunk, shouldSweep, toTableRows, TABLE } from "./syncMyobActuals.js";

const CREDS = {
  instance: "https://alcladarchitectural.myobadvanced.com",
  tenant: "Alclad Architectural Live",
  user: "nathan@alcladaus.com.au",
  pass: "p",
};

/* A fake Supabase recording upserts and deletes. */
const fakeDb = ({ upsertError = null, deleteError = null, deleted = [] } = {}) => {
  const state = { upserts: [], deletes: [] };
  return {
    state,
    from(table) {
      state.table = table;
      return {
        async upsert(rows, opts) { state.upserts.push({ rows, opts }); return { error: upsertError }; },
        delete() {
          return {
            lt(col, val) { state.deletes.push({ col, val }); return this; },
            async select() { return { data: deleted, error: deleteError }; },
          };
        },
      };
    },
  };
};

const oneRead = (rows) => async () => ({ rows, requests: 1, sessionReused: false });

// ── chunking ──────────────────────────────────────────────────────────────
test("chunking keeps every row, including the last partial one", () => {
  assert.equal(chunk(Array.from({ length: 1001 }, (_, i) => i), 500).flat().length, 1001);
  assert.equal(chunk(Array.from({ length: 1001 }, (_, i) => i), 500).length, 3);
});

test("an exact multiple does not produce an empty trailing chunk", () => {
  /* An empty upsert is a wasted request, and an empty chunk in the middle of a loop is the shape
     that hides an off-by-one. */
  const c = chunk(Array.from({ length: 1000 }, (_, i) => i), 500);
  assert.equal(c.length, 2);
  assert.ok(c.every((p) => p.length === 500));
});

test("nothing to chunk is no chunks", () => {
  assert.deepEqual(chunk([], 500), []);
});

// ── the sweep decision ────────────────────────────────────────────────────
test("a complete read with rows sweeps", () => {
  assert.equal(shouldSweep({ complete: true, rowsWritten: 10 }), true);
});

test("a read that returned NOTHING must not sweep", () => {
  /* Zero rows is indistinguishable from a renamed inquiry, a withdrawn permission, or a filter
     typo — and sweeping on it deletes every actual in the hub. */
  assert.equal(shouldSweep({ complete: true, rowsWritten: 0 }), false);
});

test("an incomplete read must not sweep", () => {
  /* Worse than the empty case: it deletes exactly the projects it did not reach. */
  assert.equal(shouldSweep({ complete: false, rowsWritten: 999 }), false);
});

// ── the row shape ─────────────────────────────────────────────────────────
test("rows carry the run's timestamp, which is what the sweep keys on", () => {
  const out = toTableRows([{ project_id: "6667", cost_code: "C", account_group: "MAT", fin_period: "202608", actual_amount: 5, actual_qty: 1, rows: 3 }], "T");
  assert.equal(out[0].synced_at, "T");
  assert.equal(out[0].source_rows, 3, "how many ledger lines made the figure");
});

// ── the whole thing ───────────────────────────────────────────────────────
test("a normal run upserts the rolled-up rows and then sweeps", async () => {
  const db = fakeDb({ deleted: [{ project_id: "old" }, { project_id: "gone" }] });
  const out = await syncActuals(db, {
    creds: CREDS,
    now: () => "2026-09-10T00:00:00.000Z",
    read: oneRead([
      { ProjectID: "6667      ", CostCodeID: "100-02-01", FinPeriodID: "202608", ActualAmount: 100, ActualQty: 1 },
      { ProjectID: "6667      ", CostCodeID: "100-02-01", FinPeriodID: "202608", ActualAmount: 50, ActualQty: 1 },
      { ProjectID: "6931", CostCodeID: "100-03-01", FinPeriodID: "202608", ActualAmount: 25, ActualQty: 2 },
    ]),
  });
  assert.equal(out.read, 3);
  assert.equal(out.rolled, 2, "three ledger rows, two project/cost-code/period figures");
  assert.equal(out.written, 2);
  assert.equal(out.ledgerRows, 3, "the report says how many ledger lines are behind the figures");
  assert.equal(out.swept, 2);
  assert.equal(db.state.table, TABLE);
  /* Trimmed on the way in — the padded ProjectID would join to nothing. */
  assert.equal(db.state.upserts[0].rows[0].project_id, "6667");
  assert.equal(db.state.upserts[0].rows[0].actual_amount, 150);
  /* Upserting on the grain, not blindly inserting: a re-run must update, not duplicate. */
  assert.equal(db.state.upserts[0].opts.onConflict, "project_id,cost_code,fin_period");
  assert.equal(db.state.deletes[0].col, "synced_at");
  assert.equal(db.state.deletes[0].val, "2026-09-10T00:00:00.000Z");
});

test("an EMPTY read writes nothing and sweeps nothing", async () => {
  /* The single most destructive thing this could do is delete every actual because MYOB answered
     with an empty list. */
  const db = fakeDb({ deleted: [{ project_id: "everything" }] });
  const out = await syncActuals(db, { creds: CREDS, read: oneRead([]) });
  assert.equal(out.written, 0);
  assert.equal(out.swept, 0);
  assert.equal(db.state.deletes.length, 0, "no delete was even attempted");
});

test("a failed upsert throws BEFORE the sweep, and says how far it got", async () => {
  /* A partial write plus a sweep is the one combination that loses data rather than delaying it. */
  const db = fakeDb({ upsertError: { message: "timeout" } });
  await assert.rejects(
    () => syncActuals(db, { creds: CREDS, read: oneRead([{ ProjectID: "6667", ActualAmount: 1 }]) }),
    (e) => {
      assert.match(e.message, /upsert failed after 0 row\(s\)/);
      assert.equal(db.state.deletes.length, 0, "the sweep must not run after a failed write");
      return true;
    });
});

test("a failed sweep is reported rather than swallowed", async () => {
  const db = fakeDb({ deleteError: { message: "nope" } });
  await assert.rejects(
    () => syncActuals(db, { creds: CREDS, read: oneRead([{ ProjectID: "6667", ActualAmount: 1 }]) }),
    /sweep failed/);
});

test("the report names WHO it connected as", async () => {
  /* While this runs under a personal login, the report is the record of that — and the thing that
     makes the eventual switch to a dedicated user visible rather than assumed. */
  const out = await syncActuals(fakeDb(), { creds: CREDS, read: oneRead([{ ProjectID: "1", ActualAmount: 1 }]) });
  assert.equal(out.as, "nathan@alcladaus.com.au");
});

test("the read is asked for the actuals inquiry, with only the columns stored", async () => {
  let asked = null;
  await syncActuals(fakeDb(), {
    creds: CREDS,
    read: async (args) => { asked = args; return { rows: [], requests: 1 }; },
  });
  assert.match(asked.inquiry, /PMHistoryByDateMaster/);
  assert.deepEqual(asked.select,
    ["ProjectID", "CostCodeID", "AccountGroupID", "FinPeriodID", "ActualAmount", "ActualQty"]);
  assert.equal(asked.tenant, CREDS.tenant);
});
