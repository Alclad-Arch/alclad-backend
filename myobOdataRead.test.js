// Reading a MYOB Generic Inquiry, and rolling the actuals up to the grain the hub compares at.
//
// Every one of these covers something that fails SILENTLY in production:
//
//   · a Basic-auth request creates an Acumatica SESSION, and sessions are what the licence counts.
//     If the cookie is not carried, a nightly sync consumes one session per page and can lock real
//     people out of MYOB. Nothing about the data would look wrong.
//   · identifiers come back space-padded ("0018      "). Untrimmed, they join to nothing in our
//     tables and raise no error — the hub would simply show every job as having no actuals.
//   · a server that ignores $skip returns the same full page for ever. Without the short-page
//     stop, a nightly job becomes an outage.
//   · NaN in a sum poisons the total and prints as NaN or 0 with no indication which.
import assert from "node:assert/strict";
import test from "node:test";
import { giUrl, trimRow, cookieHeader, readInquiry, rollUpActuals, groupTotals, ACTUALS_INQUIRY, ACTUALS_SELECT, ACTUALS_ORDER } from "./myobOdataRead.js";

const INST = "https://alcladarchitectural.myobadvanced.com";
const TENANT = "Alclad Architectural Live";

/* A fake tenant: records what it was asked, answers pages of a given size. */
const fakeServer = ({ pages, setCookie = ["UserBranch=1; path=/; secure"], status = 200 }) => {
  const seen = [];
  const impl = async (url, opts) => {
    seen.push({ url, headers: { ...(opts && opts.headers) } });
    const page = pages.shift() || [];
    return {
      ok: status < 400,
      status,
      headers: {
        getSetCookie: () => (seen.length === 1 ? setCookie : []),
        get: (k) => (k.toLowerCase() === "set-cookie" && seen.length === 1 ? setCookie[0] : null),
      },
      json: async () => ({ value: page }),
      text: async () => "boom",
    };
  };
  return { impl, seen };
};

// ── the address ───────────────────────────────────────────────────────────
test("the v4 GI route, with the tenant and inquiry encoded", () => {
  const u = giUrl(INST, TENANT, "ALX_WIP Report");
  assert.ok(u.startsWith(`${INST}/t/Alclad%20Architectural%20Live/api/odata/gi/ALX_WIP%20Report`), u);
});

test("a trailing slash on the instance does not double up", () => {
  assert.ok(!giUrl(INST + "/", TENANT, "X").includes(".com//"), giUrl(INST + "/", TENANT, "X"));
});

test("$select names only the columns we store", () => {
  /* Asking for four instead of thirty is cheaper for them, legible in their logs, and means a
     column added to the inquiry cannot change what we keep. */
  const u = giUrl(INST, TENANT, "GI", { select: ["Project", "Amount"] });
  assert.match(u, /\$select=Project,Amount/);
});

test("paging parameters are numbers, not strings pasted in", () => {
  const u = giUrl(INST, TENANT, "GI", { top: 500, skip: 1000 });
  assert.match(u, /\$top=500/);
  assert.match(u, /\$skip=1000/);
});

test("no options, no query string", () => {
  assert.ok(!giUrl(INST, TENANT, "GI").includes("?"), giUrl(INST, TENANT, "GI"));
});

// ── trimming ──────────────────────────────────────────────────────────────
test("every string is trimmed — the padded Project is the whole reason", () => {
  const r = trimRow({ Project: "0018      ", Description: " Myer ECI Works " });
  assert.equal(r.Project, "0018");
  assert.equal(r.Description, "Myer ECI Works");
});

test("…while numbers and nulls pass through untouched", () => {
  /* Coercing here would turn a genuine null amount into "" and then into 0 downstream — a figure
     nobody entered, indistinguishable from a real zero. */
  const r = trimRow({ Amount: 1234.56, Qty: null, Flag: false });
  assert.equal(r.Amount, 1234.56);
  assert.equal(r.Qty, null);
  assert.equal(r.Flag, false);
});

// ── the session ───────────────────────────────────────────────────────────
test("the cookie header keeps name=value and drops browser attributes", () => {
  assert.equal(cookieHeader(["UserBranch=1; path=/; secure", "Locale=TimeZone=GMTE0000U; path=/"]),
    "UserBranch=1; Locale=TimeZone=GMTE0000U");
});

test("nothing to send means no header at all, not an empty one", () => {
  assert.equal(cookieHeader([]), "");
  assert.equal(cookieHeader(["; path=/"]), "");
});

test("ONE SESSION PER RUN: the cookie from page one is carried on every later page", async () => {
  /* The failure this prevents is invisible in the data and expensive in MYOB: a session per page,
     until the concurrent-session slots are gone and real users cannot log in. */
  const pages = [Array.from({ length: 2 }, (_, i) => ({ Project: `p${i}` })), [{ Project: "p9" }]];
  const { impl, seen } = fakeServer({ pages });
  const out = await readInquiry({
    instance: INST, tenant: TENANT, inquiry: "GI", user: "u", pass: "p",
    pageSize: 2, fetchImpl: impl,
  });
  assert.equal(seen.length, 2, "should have paged twice");
  assert.equal(seen[0].headers.Cookie, undefined, "nothing to send on the first request");
  assert.equal(seen[1].headers.Cookie, "UserBranch=1", "the second request reuses the session");
  assert.equal(out.sessionReused, true);
});

test("credentials go as Basic, not in the URL", async () => {
  const { impl, seen } = fakeServer({ pages: [[]] });
  await readInquiry({ instance: INST, tenant: TENANT, inquiry: "GI", user: "u", pass: "p", fetchImpl: impl });
  assert.equal(seen[0].headers.Authorization, "Basic " + Buffer.from("u:p").toString("base64"));
  assert.ok(!seen[0].url.includes("u:p"), seen[0].url);
});

// ── paging ────────────────────────────────────────────────────────────────
test("a SHORT page ends the read", async () => {
  const { impl, seen } = fakeServer({ pages: [[{ a: 1 }, { a: 2 }], [{ a: 3 }]] });
  const out = await readInquiry({ instance: INST, tenant: TENANT, inquiry: "GI", user: "u", pass: "p", pageSize: 2, fetchImpl: impl });
  assert.equal(out.rows.length, 3);
  assert.equal(seen.length, 2);
});

test("maxRows stops a runaway read", async () => {
  /* A server that ignores $skip hands back the same full page for ever. Without this the nightly
     job never finishes — and it would be the app that fell over, not MYOB. */
  const full = () => [{ a: 1 }, { a: 2 }];
  const impl = async () => ({
    ok: true, status: 200,
    headers: { getSetCookie: () => [], get: () => null },
    json: async () => ({ value: full() }), text: async () => "",
  });
  const out = await readInquiry({
    instance: INST, tenant: TENANT, inquiry: "GI", user: "u", pass: "p",
    pageSize: 2, maxRows: 5, fetchImpl: impl,
  });
  assert.equal(out.rows.length, 5);
});

test("a failure names the inquiry and carries the status", async () => {
  const { impl } = fakeServer({ pages: [[]], status: 403 });
  await assert.rejects(
    () => readInquiry({ instance: INST, tenant: TENANT, inquiry: "ALX_PMCostProjectionLines", user: "u", pass: "p", fetchImpl: impl }),
    (e) => {
      assert.match(e.message, /ALX_PMCostProjectionLines/);
      assert.equal(e.status, 403);
      return true;
    });
});

test("missing credentials is refused before any request is made", async () => {
  await assert.rejects(() => readInquiry({ instance: INST, tenant: TENANT, inquiry: "GI" }), /username and password/);
  await assert.rejects(() => readInquiry({ user: "u", pass: "p" }), /instance, tenant and inquiry/);
});

// ── the roll-up ───────────────────────────────────────────────────────────
test("the actuals select asks for exactly the columns stored", () => {
  assert.deepEqual(ACTUALS_SELECT,
    ["Project", "ProjectName", "CostCode", "AccountGroup", "CostCodeGrp", "FinPeriod", "Amount", "Qty", "TranID"]);
});

test("per-transaction rows sum to one row per project, cost code and period", () => {
  /* ALX_JobTrans is per TRANSACTION; the hub compares per cost code. */
  const out = rollUpActuals([
    { Project: "6667      ", CostCode: "100-02-01", AccountGroup: "MAT", FinPeriod: "202608", Amount: 100.005, Qty: 1 },
    { Project: "6667      ", CostCode: "100-02-01", AccountGroup: "MAT", FinPeriod: "202608", Amount: 50.005, Qty: 2 },
    { Project: "6667      ", CostCode: "100-03-01", AccountGroup: "LAB", FinPeriod: "202608", Amount: 25, Qty: 3 },
  ]);
  assert.equal(out.length, 2);
  const mat = out.find((r) => r.cost_code === "100-02-01");
  assert.equal(mat.project_id, "6667", "trimmed on the way through");
  assert.equal(mat.actual_amount, 150.01);
  assert.equal(mat.actual_qty, 3);
  assert.equal(mat.rows, 2, "how many ledger rows made the figure — traceability, not decoration");
});

test("periods are kept apart", () => {
  const out = rollUpActuals([
    { Project: "6667", CostCode: "C", FinPeriod: "202607", Amount: 10 },
    { Project: "6667", CostCode: "C", FinPeriod: "202608", Amount: 20 },
  ]);
  assert.equal(out.length, 2);
});

test("an unparseable amount contributes nothing rather than poisoning the sum", () => {
  /* Number(undefined) is NaN and one NaN destroys the whole total, printing as NaN or as 0 with
     no way to tell which happened. */
  const out = rollUpActuals([
    { Project: "6667", CostCode: "C", FinPeriod: "P", Amount: 100 },
    { Project: "6667", CostCode: "C", FinPeriod: "P", Amount: undefined },
    { Project: "6667", CostCode: "C", FinPeriod: "P", Amount: "not a number" },
  ]);
  assert.equal(out[0].actual_amount, 100);
  assert.equal(out[0].rows, 3, "the rows are still counted — the figure is short, and it says so");
});

test("a row with no project is dropped, not filed under blank", () => {
  const out = rollUpActuals([
    { Project: "   ", CostCode: "C", Amount: 999 },
    { Project: "6667", CostCode: "C", Amount: 1 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].project_id, "6667");
});

test("a missing cost code becomes blank, not dropped", () => {
  /* Project-level costs with no cost code are real. Dropping them would understate the job total
     while every line looked right — the hardest kind of discrepancy to find. */
  const out = rollUpActuals([{ Project: "6667", FinPeriod: "P", Amount: 42 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].cost_code, "");
  assert.equal(out[0].actual_amount, 42);
});

test("nothing in, nothing out", () => {
  assert.deepEqual(rollUpActuals([]), []);
  assert.deepEqual(rollUpActuals(), []);
});

// ── $orderby, and knowing whether the read finished ───────────────────────
test("$orderby is sent, because $skip without one is undefined paging", () => {
  /* Two pages of an unordered result can repeat one row and omit another; across 33,000-odd rows
     the total comes out quietly short and reads like a slow month. */
  const u = giUrl(INST, TENANT, "ALX_JobTrans", { orderBy: "TranID", top: 500, skip: 500 });
  assert.match(u, /[?&]\$orderby=TranID/);
});

test("no orderBy, no parameter — it is not silently defaulted to a guess", () => {
  assert.ok(!giUrl(INST, TENANT, "GI", { top: 10 }).includes("$orderby"));
});

test("the actuals feed is ALX_JobTrans, ordered on a column it actually selects", () => {
  /* PMHistoryByDateMaster was keyed on an internal integer that joins to no hub project, and its
     rows mixed income with cost. */
  assert.equal(ACTUALS_INQUIRY, "ALX_JobTrans");
  assert.equal(ACTUALS_ORDER, "TranID");
  assert.ok(ACTUALS_SELECT.includes(ACTUALS_ORDER),
    "ordering on a column outside $select is how a 400 arrives at 2am");
});

test("a read that ends on a short page reports COMPLETE", async () => {
  const srv = fakeServer({ pages: [[{ Project: "a" }, { Project: "b" }], [{ Project: "c" }]] });
  const out = await readInquiry({
    instance: INST, tenant: TENANT, inquiry: "GI", user: "u", pass: "p",
    pageSize: 2, fetchImpl: srv.impl,
  });
  assert.equal(out.rows.length, 3);
  assert.equal(out.complete, true, "the second page was short, so the inquiry was exhausted");
});

test("a read TRUNCATED at maxRows reports INCOMPLETE", async () => {
  /* This flag exists so the sweep can refuse to run. Reported wrongly here, the sweep deletes
     precisely the projects the read never reached. */
  /* Full pages for ever — the read can only stop because of the cap. */
  const srv = fakeServer({
    pages: Array.from({ length: 10 }, () => [{ Project: "x" }, { Project: "y" }]),
  });
  const out = await readInquiry({
    instance: INST, tenant: TENANT, inquiry: "GI", user: "u", pass: "p",
    pageSize: 2, maxRows: 4, fetchImpl: srv.impl,
  });
  assert.equal(out.rows.length, 4);
  assert.equal(out.complete, false, "it stopped on the cap, not because MYOB ran out of rows");
});

// ── what each account group contributes ──────────────────────────────────
test("group totals separate the account groups, biggest first", () => {
  /* The 10.7M project figure was income and cost added together, and no per-project number could
     have shown that. */
  const g = groupTotals([
    { AccountGroup: "STAFF     ", Amount: 100 },
    { AccountGroup: "MATERIAL  ", Amount: 900 },
    { AccountGroup: "STAFF", Amount: 50 },
  ]);
  assert.deepEqual(g.map((x) => x.account_group), ["MATERIAL", "STAFF"]);
  assert.equal(g[0].amount, 900);
  assert.equal(g[1].amount, 150, "padded and unpadded are the same group");
  assert.equal(g[1].rows, 2);
});

test("group totals rank on SIZE, so a large credit is not hidden at the bottom", () => {
  const g = groupTotals([{ AccountGroup: "A", Amount: 10 }, { AccountGroup: "B", Amount: -900 }]);
  assert.equal(g[0].account_group, "B");
});

test("a row with no account group is counted, not dropped", () => {
  /* Dropping it would make the group totals disagree with the project totals for no visible
     reason — the kind of small discrepancy that costs an afternoon. */
  const g = groupTotals([{ Amount: 5 }]);
  assert.equal(g[0].account_group, "(none)");
  assert.equal(g[0].amount, 5);
});
