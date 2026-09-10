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
import { giUrl, trimRow, cookieHeader, readInquiry, rollUpActuals, ACTUALS_SELECT } from "./myobOdataRead.js";

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
  const u = giUrl(INST, TENANT, "GI", { select: ["ProjectID", "ActualAmount"] });
  assert.match(u, /\$select=ProjectID,ActualAmount/);
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
test("every string is trimmed — the padded ProjectID is the whole reason", () => {
  const r = trimRow({ ProjectID: "0018      ", Description: " Myer ECI Works " });
  assert.equal(r.ProjectID, "0018");
  assert.equal(r.Description, "Myer ECI Works");
});

test("…while numbers and nulls pass through untouched", () => {
  /* Coercing here would turn a genuine null amount into "" and then into 0 downstream — a figure
     nobody entered, indistinguishable from a real zero. */
  const r = trimRow({ ActualAmount: 1234.56, ActualQty: null, Flag: false });
  assert.equal(r.ActualAmount, 1234.56);
  assert.equal(r.ActualQty, null);
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
  const pages = [Array.from({ length: 2 }, (_, i) => ({ ProjectID: `p${i}` })), [{ ProjectID: "p9" }]];
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
test("the actuals select asks for exactly the six columns stored", () => {
  assert.deepEqual(ACTUALS_SELECT,
    ["ProjectID", "CostCodeID", "AccountGroupID", "FinPeriodID", "ActualAmount", "ActualQty"]);
});

test("per-date rows sum to one row per project, cost code and period", () => {
  /* PMHistoryByDateMaster is per DATE; the hub compares per cost code. */
  const out = rollUpActuals([
    { ProjectID: "6667      ", CostCodeID: "100-02-01", AccountGroupID: "MAT", FinPeriodID: "202608", ActualAmount: 100.005, ActualQty: 1 },
    { ProjectID: "6667      ", CostCodeID: "100-02-01", AccountGroupID: "MAT", FinPeriodID: "202608", ActualAmount: 50.005, ActualQty: 2 },
    { ProjectID: "6667      ", CostCodeID: "100-03-01", AccountGroupID: "LAB", FinPeriodID: "202608", ActualAmount: 25, ActualQty: 3 },
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
    { ProjectID: "6667", CostCodeID: "C", FinPeriodID: "202607", ActualAmount: 10 },
    { ProjectID: "6667", CostCodeID: "C", FinPeriodID: "202608", ActualAmount: 20 },
  ]);
  assert.equal(out.length, 2);
});

test("an unparseable amount contributes nothing rather than poisoning the sum", () => {
  /* Number(undefined) is NaN and one NaN destroys the whole total, printing as NaN or as 0 with
     no way to tell which happened. */
  const out = rollUpActuals([
    { ProjectID: "6667", CostCodeID: "C", FinPeriodID: "P", ActualAmount: 100 },
    { ProjectID: "6667", CostCodeID: "C", FinPeriodID: "P", ActualAmount: undefined },
    { ProjectID: "6667", CostCodeID: "C", FinPeriodID: "P", ActualAmount: "not a number" },
  ]);
  assert.equal(out[0].actual_amount, 100);
  assert.equal(out[0].rows, 3, "the rows are still counted — the figure is short, and it says so");
});

test("a row with no project is dropped, not filed under blank", () => {
  const out = rollUpActuals([
    { ProjectID: "   ", CostCodeID: "C", ActualAmount: 999 },
    { ProjectID: "6667", CostCodeID: "C", ActualAmount: 1 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].project_id, "6667");
});

test("a missing cost code becomes blank, not dropped", () => {
  /* Project-level costs with no cost code are real. Dropping them would understate the job total
     while every line looked right — the hardest kind of discrepancy to find. */
  const out = rollUpActuals([{ ProjectID: "6667", FinPeriodID: "P", ActualAmount: 42 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].cost_code, "");
  assert.equal(out[0].actual_amount, 42);
});

test("nothing in, nothing out", () => {
  assert.deepEqual(rollUpActuals([]), []);
  assert.deepEqual(rollUpActuals(), []);
});
