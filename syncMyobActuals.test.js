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
import { GROUPS_INQUIRY } from "./myobOdataRead.js";

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

/* The tenant's account-group classification: revenue by package, cost by category. */
const GROUPS = [
  { AccountGroupCD: "MATERIAL  ", Type: "Expense" },
  { AccountGroupCD: "STAFF     ", Type: "Expense" },
  { AccountGroupCD: "GLAZING   ", Type: "Income" },
  { AccountGroupCD: "CLADDING  ", Type: "Income" },
];

/* A SYNC MAKES TWO READS: the classification, then the ledger. A fake that answers both with the
   same rows is how the first version of these tests passed while classifying nothing. */
const oneRead = (rows, complete = true, groups = GROUPS) => async (args) => (
  args.inquiry === GROUPS_INQUIRY
    ? { rows: groups, requests: 1, complete: true, cookie: "ASP.NET_SessionId=abc" }
    : { rows, requests: 1, complete, cookie: args.cookie || "", sessionReused: !!args.cookie }
);

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
      { Project: "6667      ", CostCode: "2000202", AccountGroup: "MATERIAL", FinPeriod: "022027", Amount: 100, Qty: 1 },
      { Project: "6667      ", CostCode: "2000202", AccountGroup: "MATERIAL", FinPeriod: "022027", Amount: 50, Qty: 1 },
      { Project: "6931", CostCode: "2000102", AccountGroup: "STAFF", FinPeriod: "022027", Amount: 25, Qty: 2 },
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
    () => syncActuals(db, { creds: CREDS, read: oneRead([{ Project: "6667", AccountGroup: "STAFF", Amount: 1 }]) }),
    (e) => {
      assert.match(e.message, /upsert failed after 0 row\(s\)/);
      assert.equal(db.state.deletes.length, 0, "the sweep must not run after a failed write");
      return true;
    });
});

test("a failed sweep is reported rather than swallowed", async () => {
  const db = fakeDb({ deleteError: { message: "nope" } });
  await assert.rejects(
    () => syncActuals(db, { creds: CREDS, read: oneRead([{ Project: "6667", AccountGroup: "STAFF", Amount: 1 }]) }),
    /sweep failed/);
});

test("the report names WHO it connected as", async () => {
  /* While this runs under a personal login, the report is the record of that — and the thing that
     makes the eventual switch to a dedicated user visible rather than assumed. */
  const out = await syncActuals(fakeDb(), { creds: CREDS, read: oneRead([{ Project: "1", AccountGroup: "STAFF", Amount: 1 }]) });
  assert.equal(out.as, "nathan@alcladaus.com.au");
});

test("the read is asked for the actuals inquiry, with only the columns stored", async () => {
  let asked = null;
  await syncActuals(fakeDb(), {
    creds: CREDS,
    read: async (args) => {
      if (args.inquiry === GROUPS_INQUIRY) return { rows: GROUPS, requests: 1, complete: true, cookie: "c" };
      asked = args;
      return { rows: [], requests: 1, complete: true };
    },
  });
  /* ALX_JobTrans, not PMHistoryByDateMaster. The dry run proved PMHistory's ProjectID is an
     internal integer that joins to no hub project, and that its rows mix income with cost. */
  assert.equal(asked.inquiry, "ALX_JobTrans");
  assert.deepEqual(asked.select,
    ["Project", "ProjectName", "CostCode", "AccountGroup", "CostCodeGrp", "FinPeriod", "Amount", "Qty", "TranID"]);
  assert.equal(asked.orderBy, "TranID", "paging $skip without an order can drop rows");
  assert.equal(asked.tenant, CREDS.tenant);
});

// ── the sweep guard has to be REACHABLE ───────────────────────────────────
test("a TRUNCATED read writes its rows but must not sweep", async () => {
  /* This is the bug the guard was written for and could not catch: syncActuals passed
     `complete: true` literally, so a read that stopped at maxRows still swept — deleting exactly
     the projects it never reached. Now completeness comes from the read. */
  const db = fakeDb({ deleted: [{ project_id: "never-reached" }] });
  const out = await syncActuals(db, {
    creds: CREDS,
    read: oneRead([{ Project: "6931", CostCode: "2000102", AccountGroup: "STAFF", FinPeriod: "022027", Amount: 10 }], false),
  });
  assert.equal(out.written, 1, "what was read is still written");
  assert.equal(out.swept, 0);
  assert.equal(out.complete, false, "and the report says the read was short");
  assert.equal(db.state.deletes.length, 0, "no delete was attempted");
});

test("a reader that does not report completeness leaves rows alone", async () => {
  /* Stale for a day is recoverable; swept because a field was missing is not. */
  const db = fakeDb({ deleted: [{ project_id: "x" }] });
  const out = await syncActuals(db, {
    creds: CREDS,
    /* The classification read is normal; it is the LEDGER read that omits `complete`. */
    read: async (args) => (args.inquiry === GROUPS_INQUIRY
      ? { rows: GROUPS, requests: 1, complete: true, cookie: "c" }
      : { rows: [{ Project: "6931", AccountGroup: "STAFF", Amount: 5 }], requests: 1 }),
  });
  assert.equal(out.swept, 0);
  assert.equal(db.state.deletes.length, 0);
});

// ── cost only, and refusing rather than guessing ──────────────────────────
test("INCOME rows are excluded — this is the 10.7M bug", async () => {
  /* Alclad bills revenue through groups named after the packages and costs through groups named by
     category. Summed together, one project reported 10,734,945.75. */
  const db = fakeDb();
  const out = await syncActuals(db, {
    creds: CREDS,
    read: oneRead([
      { Project: "6931", CostCode: "2000202", AccountGroup: "MATERIAL", FinPeriod: "022027", Amount: 1000, Qty: 1 },
      { Project: "6931", CostCode: "2000202", AccountGroup: "GLAZING", FinPeriod: "022027", Amount: -5000, Qty: 0 },
    ]),
  });
  assert.equal(out.rolled, 1, "the income row makes no figure of its own");
  assert.equal(db.state.upserts[0].rows[0].actual_amount, 1000, "and does not net off the cost");
});

test("the report says which groups counted as cost and which as income", async () => {
  /* The answer now comes from the tenant, so it has to be visible in the run rather than read out
     of this file. */
  const out = await syncActuals(fakeDb(), {
    creds: CREDS,
    read: oneRead([{ Project: "6931", AccountGroup: "STAFF", Amount: 1 }]),
  });
  assert.deepEqual(out.costGroups, ["MATERIAL", "STAFF"]);
  assert.deepEqual(out.incomeGroups, ["CLADDING", "GLAZING"]);
});

test("NO Expense groups refuses to sync, and writes nothing", async () => {
  /* Both fallbacks are wrong: every group files revenue as cost, no group empties the hub. */
  const db = fakeDb();
  await assert.rejects(
    () => syncActuals(db, {
      creds: CREDS,
      read: oneRead([{ Project: "6931", AccountGroup: "STAFF", Amount: 1 }], true,
        [{ AccountGroupCD: "GLAZING", Type: "Income" }]),
    }),
    /no Expense groups/);
  assert.equal(db.state.upserts.length, 0);
  assert.equal(db.state.deletes.length, 0);
});

test("a ledger group the classification has never heard of refuses to sync", async () => {
  /* New income would corrupt every total it touches; new cost would be missing from them. Nothing
     here can tell which, so it stops and names the group. */
  const db = fakeDb();
  await assert.rejects(
    () => syncActuals(db, {
      creds: CREDS,
      read: oneRead([{ Project: "6931", AccountGroup: "FREIGHT", Amount: 1 }]),
    }),
    /FREIGHT/);
  assert.equal(db.state.upserts.length, 0);
});

test("a BLANK account group refuses too, rather than vanishing", async () => {
  /* It would be filtered out of the cost roll-up and disappear into the large, expected income
     exclusion with nothing to show it had gone. */
  await assert.rejects(
    () => syncActuals(fakeDb(), {
      creds: CREDS,
      read: oneRead([{ Project: "6931", Amount: 999 }]),
    }),
    /\(blank\)/);
});

test("both reads share ONE session", async () => {
  /* Sessions, not requests, are what the Acumatica licence counts. */
  const seen = [];
  await syncActuals(fakeDb(), {
    creds: CREDS,
    read: async (args) => {
      seen.push({ inquiry: args.inquiry, cookie: args.cookie || null });
      if (args.inquiry === GROUPS_INQUIRY) return { rows: GROUPS, requests: 1, complete: true, cookie: "SESS=1" };
      return { rows: [], requests: 1, complete: true, cookie: args.cookie };
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].inquiry, GROUPS_INQUIRY, "classification first — without it nothing is safe to store");
  assert.equal(seen[1].cookie, "SESS=1", "the ledger read reuses the session the first one opened");
});

// ── the daily guard ───────────────────────────────────────────────────────
/* A scheduler's memory is not a guard: a web-service timer re-arms on every restart and exists once
   per instance, so N instances mean N syncs and N Acumatica sessions. Sessions are what the licence
   counts, so a double-run is a step towards locking real people out of MYOB. The decision therefore
   comes from max(synced_at) in the data, which is shared and survives restarts. */
const dbWithLastSync = (iso) => {
  const base = fakeDb();
  const orig = base.from.bind(base);
  base.from = (table) => {
    const t = orig(table);
    t.select = (cols) => ({
      order: () => ({ limit: async () => ({ data: iso === undefined ? [] : [{ synced_at: iso }], error: null }) }),
    });
    return t;
  };
  return base;
};

test("guard OFF by default — a deliberate run is never silently skipped", async () => {
  /* Someone at a terminal, or a cron job with a schedule of its own, must not be second-guessed. */
  const out = await syncActuals(fakeDb(), {
    creds: CREDS, read: oneRead([{ Project: "6931", AccountGroup: "STAFF", Amount: 1 }]),
  });
  assert.equal(out.skipped, false);
  assert.equal(out.written, 1);
});

test("guard ON skips when the data says it already ran today", async () => {
  const db = dbWithLastSync(new Date(Date.now() - 2 * 3600000).toISOString());
  let readCalled = false;
  const out = await syncActuals(db, {
    creds: CREDS, guard: true,
    read: async () => { readCalled = true; return { rows: [], requests: 1, complete: true }; },
  });
  assert.equal(out.skipped, true);
  assert.match(out.reason, /under the 20h minimum/);
  /* NOT ONE REQUEST TO MYOB. The guard has to decide before the session is opened, or it has
     already cost the thing it exists to protect. */
  assert.equal(readCalled, false, "MYOB must not be contacted at all");
  assert.equal(out.requests, 0);
});

test("guard ON runs when the last sync is old", async () => {
  const db = dbWithLastSync(new Date(Date.now() - 30 * 3600000).toISOString());
  const out = await syncActuals(db, {
    creds: CREDS, guard: true,
    read: oneRead([{ Project: "6931", AccountGroup: "STAFF", Amount: 1 }]),
  });
  assert.equal(out.skipped, false);
  assert.equal(out.written, 1);
});

test("guard ON runs when nothing has ever synced", async () => {
  /* An empty table means every linked project shows no cost; waiting for a window helps nobody. */
  const out = await syncActuals(dbWithLastSync(undefined), {
    creds: CREDS, guard: true,
    read: oneRead([{ Project: "6931", AccountGroup: "STAFF", Amount: 1 }]),
  });
  assert.equal(out.skipped, false);
  assert.equal(out.written, 1);
});

test("a skip is shaped like a result, not an exception", async () => {
  /* A caller should not have to tell a decision from a failure — the scheduler logs both. */
  const db = dbWithLastSync(new Date().toISOString());
  const out = await syncActuals(db, { creds: CREDS, guard: true, read: oneRead([]) });
  for (const k of ['read', 'rolled', 'written', 'swept', 'requests']) {
    assert.equal(out[k], 0, `${k} should be 0 on a skip`);
  }
  assert.equal(out.swept, 0, 'and above all it must not sweep');
});
