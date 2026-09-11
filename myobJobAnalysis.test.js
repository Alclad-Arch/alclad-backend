// Contract value, budget and forecast per job, from ALX_JobAnalysis.
//
// The fixtures are REAL rows — job 6931's single row and job 3817's four — as returned on
// 2026-09-10. That matters more than usual here, because an invented fixture is exactly how the
// first version of this module went wrong: it split the columns by account-group side, job 3817
// happens to be arranged that way, and the assumption looked verified. Job 6931 proved it false —
// its BudgetRevenue of 69,110 sits on a SUBCONT row, an EXPENSE group — and the split had been
// discarding the contract value of all but 5 of 165 jobs.
//
// Three figures are checked against sources OUTSIDE this inquiry, which is what makes them
// evidence rather than restatement:
//   6931  BudgetRevenue 69,110.00      = Revised Contract Value on the MYOB Projects screen
//   6931  CostsToDate   48,146.56      = myob_actuals.actual_cost, from ALX_JobTrans
//   3817  CostsToDate   3,749,975.19   = myob_actuals.actual_cost, from ALX_JobTrans
import assert from "node:assert/strict";
import test from "node:test";
import {
  rollUpJobAnalysis, scopeForType, BUDGET_SELECT, BUDGET_INQUIRY, BUDGET_NUMERIC, TYPE_TO_SCOPE,
} from "./myobJobAnalysis.js";

/* Job 6931, verbatim — one row, and every figure on it matches the MYOB Projects screen. */
const J6931 = [{
  Project: '6931      ', ProjectName: 'KM William Angliss', Type: 'C', Stage: 'Not Started',
  ProjectManager: null,
  BudgetRevenue: 69110, ContractVariations: 0, BudgetCost: 0,
  InvoicedAmt: 0, CostsToDate: 48146.56, RetainedAmt: 0, PendingInvoiceAmt: 0,
  DraftInvoicedAmt: 34555, ForecastGP: 39245.91, CostAtCompletion: 29864.09,
  CostProjection: -23648.47, OpenCommittedAmt: 5366,
  /* The row's AccountGroupID is SUBCONT — an EXPENSE group carrying the contract value. Kept in the
     fixture precisely because it is what disproved the side-split. */
  AccountGroupID: 'SUBCONT   ',
}];

/* Job 3817, verbatim — four rows, the multi-row case. */
const J3817 = [
  { Project: '3817      ', ProjectName: '181 William St & 550 Bourke St', Type: 'R', Stage: 'Completed',
    ProjectManager: 'BENSAIED Anouar, Mr', AccountGroupID: 'RECLAD    ',
    BudgetRevenue: 4011186.35, ContractVariations: 511540.31, BudgetCost: 0,
    InvoicedAmt: 3890777.47, CostsToDate: 0, CostAtCompletion: 0, ForecastGP: 4011186.35 },
  { Project: '3817      ', ProjectName: '181 William St & 550 Bourke St', Type: 'G', Stage: 'Completed',
    ProjectManager: 'BENSAIED Anouar, Mr', AccountGroupID: 'STAFF     ',
    BudgetRevenue: 0, ContractVariations: 0, BudgetCost: 0, InvoicedAmt: 0, CostsToDate: 0 },
  { Project: '3817      ', ProjectName: '181 William St & 550 Bourke St', Type: 'C', Stage: 'Completed',
    ProjectManager: 'BENSAIED Anouar, Mr', AccountGroupID: 'STAFF     ',
    BudgetRevenue: 0, ContractVariations: 0, BudgetCost: 0, InvoicedAmt: 0, CostsToDate: 4800,
    CostProjection: -4800 },
  { Project: '3817      ', ProjectName: '181 William St & 550 Bourke St', Type: 'R', Stage: 'Completed',
    ProjectManager: 'BENSAIED Anouar, Mr', AccountGroupID: 'SUBCONT   ',
    BudgetRevenue: 0, ContractVariations: -355478.48, BudgetCost: 2786153.48,
    InvoicedAmt: 0, CostsToDate: 3745175.19, CostAtCompletion: 3687992.71,
    ForecastGP: -3687992.71, CostProjection: -57182.48 },
];

const total = (rows, field) => Math.round(rows.reduce((n, r) => n + r[field], 0) * 100) / 100;

// ── the inquiry ───────────────────────────────────────────────────────────
test("reads ALX_JobAnalysis and does NOT request ContractValueIncVar", () => {
  assert.equal(BUDGET_INQUIRY, 'ALX_JobAnalysis');
  /* Not fetching it is the point: its name says contract value and its formula is
     BudgetRevenue - BudgetCost + ContractVariations, which is gross profit. Having it in hand
     would invite someone to use it for the one thing it must never be used for. */
  assert.ok(!BUDGET_SELECT.includes('ContractValueIncVar'));
  for (const c of ['Project', 'Type', 'BudgetRevenue', 'ContractVariations', 'BudgetCost', 'Stage']) {
    assert.ok(BUDGET_SELECT.includes(c), `${c} must be selected`);
  }
});

// ── 6931: verified against the MYOB screen, figure by figure ─────────────
test("6931's contract value is 69,110 — the Revised Contract Value on the MYOB screen", () => {
  const [r] = rollUpJobAnalysis(J6931);
  assert.equal(r.contract_value, 69110);
  assert.equal(r.budget_revenue, 69110);
  assert.equal(r.contract_variations, 0);
});

test("…and it is read from a row whose AccountGroupID is an EXPENSE group", () => {
  /* THE TEST THAT KILLS THE OLD MODEL. Reading revenue only from Income-group rows would return 0
     here, and did — for 160 of 165 jobs. */
  assert.equal(J6931[0].AccountGroupID.trim(), 'SUBCONT');
  assert.equal(rollUpJobAnalysis(J6931)[0].contract_value, 69110);
});

test("…its costs to date match ALX_JobTrans, from a different inquiry entirely", () => {
  assert.equal(rollUpJobAnalysis(J6931)[0].costs_to_date, 48146.56);
});

test("…and MYOB's forecast comes through", () => {
  const [r] = rollUpJobAnalysis(J6931);
  assert.equal(r.forecast_gp, 39245.91, 'Projected GP $ on the screen');
  assert.equal(r.cost_at_completion, 29864.09, 'Projected Cost at Completion');
  assert.equal(r.draft_invoiced, 34555, 'Proforma Invoices');
  assert.equal(r.open_committed, 5366);
});

test("…with no cost budget, which is the state Jed described", () => {
  /* MYOB writes an unpopulated budget as 0.00, which is why its own screen reports this job at GP
     100%. Stored as zero; the view marks it and nulls the GP. */
  assert.equal(rollUpJobAnalysis(J6931)[0].budget_cost, 0);
});

test("a null ProjectManager does not become the string 'null'", () => {
  /* 6931's is null. Coercing it would put "null" on a project card. */
  assert.equal(rollUpJobAnalysis(J6931)[0].project_manager, '');
});

// ── 3817: the multi-row case, cross-checked ──────────────────────────────
test("3817's costs to date sum to 3,749,975.19 — ALX_JobTrans agrees to the cent", () => {
  /* The proof that the rows are additive slices rather than repeated totals. */
  assert.equal(total(rollUpJobAnalysis(J3817), 'costs_to_date'), 3749975.19);
});

test("…and its invoiced amount matches too", () => {
  assert.equal(total(rollUpJobAnalysis(J3817), 'invoiced'), 3890777.47);
});

test("…budget cost sums across the rows that carry it", () => {
  assert.equal(total(rollUpJobAnalysis(J3817), 'budget_cost'), 2786153.48);
});

test("the contract value is BudgetRevenue, and does NOT add the variations again", () => {
  /* Changed 2026-09-11. This asserted 4,167,248.18 — BudgetRevenue plus contract_variations — and
     carried a note that it was "NOT verified against MYOB's screen for this job". It never could
     have failed: the other test for this rule used job 6931, which has ZERO variations, so both
     formulas agree there, and the cross-check for 3817 compared our sum against MYOB's
     ContractValueIncVar, which is BudgetGP + ContractVariations — the same arithmetic, since
     BudgetGP equals BudgetRevenue on an income row. Two tests, neither able to catch it.

     Jed's screens caught it. BudgetRevenue is MYOB's REVISED contract value, variations already
     in: on 5477, Original 2,350,000.00 + Revised Variation 2,460,337.21 = Revised Contract Value
     4,810,337.21, which is exactly the BudgetRevenue we store for that job. */
  const rows = rollUpJobAnalysis(J3817);
  assert.equal(total(rows, 'budget_revenue'), 4011186.35);
  assert.equal(total(rows, 'contract_value'), 4011186.35);
  /* Still read and still stored — but nothing computes from it, and this asserts that. It is not
     a variation total: it read 511,540.31 when 3817 was probed and 156,061.83 once synced, and on
     6157 it was −14,823.01 against real change orders of +5,861.67. */
  assert.equal(total(rows, 'contract_variations'), 156061.83);
  assert.notEqual(total(rows, 'contract_value'), 4167248.18);
});

test("a job WITH variations proves the two formulas differ", () => {
  /* The guard the old suite lacked. 6931 has no variations, so it cannot tell
     `budget_revenue` from `budget_revenue + contract_variations` — which is exactly how the wrong
     formula passed for a month. This row has a non-zero variations figure of each sign, so
     reinstating the addition fails here immediately. */
  for (const v of [250000, -250000]) {
    const [r] = rollUpJobAnalysis([{
      Project: '9001', ProjectName: 'Variations Ltd', Type: 'C',
      AccountGroupID: 'CLAD', BudgetRevenue: 1000000, ContractVariations: v,
    }]);
    assert.equal(r.budget_revenue, 1000000);
    assert.equal(r.contract_variations, v);
    assert.equal(r.contract_value, 1000000, `contract_value moved with a variations figure of ${v}`);
  }
});

test("the figure ContractValueIncVar would have given is NOT produced", () => {
  /* 1,381,094.70 is what summing that column yields, and it would look plausible on a card. Named
     here so the number is in the file. */
  assert.notEqual(total(rollUpJobAnalysis(J3817), 'contract_value'), 1381094.70);
});

// ── the grain ─────────────────────────────────────────────────────────────
test("rolls up to project × package type", () => {
  const rows = rollUpJobAnalysis(J3817);
  assert.equal(rows.length, 3, 'three types across four rows — R appears twice');
  assert.deepEqual(rows.map((r) => r.package_type).sort(), ['C', 'G', 'R']);
  const r = rows.find((x) => x.package_type === 'R');
  assert.equal(r.source_rows, 2);
  assert.equal(r.budget_cost, 2786153.48, "the R rows' figures combine");
});

test("the project id is trimmed — MYOB pads it", () => {
  assert.ok(rollUpJobAnalysis(J3817).every((r) => r.project_id === '3817'));
  assert.equal(rollUpJobAnalysis(J6931)[0].project_id, '6931');
});

test("no account-group classification is needed or accepted", () => {
  /* The signature takes rows only. An earlier version took the classification and used it to split
     the columns by side, which is what discarded 160 contract values — passing one now cannot
     change the answer because there is nothing to pass it to. */
  /* 0, not 1: a parameter with a default does not count toward Function.length. Asserting 1 was
     my own slip — the point stands, which is that there is no second parameter to pass a
     classification to. */
  assert.equal(rollUpJobAnalysis.length, 0);
  assert.equal(rollUpJobAnalysis(J6931)[0].contract_value, 69110);
});

test("descriptive fields take the FIRST non-empty value", () => {
  const rows = rollUpJobAnalysis([
    { ...J3817[1], ProjectName: '', ProjectManager: '', Stage: '' },
    J3817[1],
  ]);
  assert.equal(rows[0].project_name, '181 William St & 550 Bourke St');
  assert.equal(rows[0].stage, 'Completed');
});

// ── the package mapping ───────────────────────────────────────────────────
test("Type maps to the hub's scope vocabulary", () => {
  assert.equal(scopeForType('C'), 'Cladding');
  assert.equal(scopeForType('G'), 'Glazing');
  assert.equal(scopeForType('R'), 'Recladding');
  assert.equal(scopeForType('F'), 'Fins');
  assert.deepEqual(Object.keys(TYPE_TO_SCOPE).sort(), ['C', 'F', 'G', 'R']);
  /* 6931 is a cladding job and MYOB says Type C. */
  assert.equal(rollUpJobAnalysis(J6931)[0].package_scope, 'Cladding');
});

test("an unrecognised Type is left BLANK, not guessed", () => {
  /* A wrong package silently attributes a contract to the wrong scope — worse than an unmapped
     one, which at least shows up as missing. */
  assert.equal(scopeForType('X'), '');
  assert.equal(scopeForType(''), '');
  assert.equal(scopeForType(null), '');
  const [r] = rollUpJobAnalysis([{ ...J6931[0], Type: 'X' }]);
  assert.equal(r.package_scope, '');
  assert.equal(r.package_type, 'X', 'the raw letter is kept, so it can be looked into');
});

// ── arithmetic safety ─────────────────────────────────────────────────────
test("an unparseable figure contributes nothing rather than NaN", () => {
  const rows = rollUpJobAnalysis([
    { ...J6931[0], BudgetRevenue: 'not a number' },
    { ...J6931[0], BudgetRevenue: undefined },
    J6931[0],
  ]);
  assert.equal(rows[0].budget_revenue, 69110, 'the one good row survives intact');
  assert.equal(rows[0].contract_value, 69110);
});

test("every numeric field is present on every row, so no reader has to guard", () => {
  for (const r of [...rollUpJobAnalysis(J3817), ...rollUpJobAnalysis(J6931)]) {
    for (const f of BUDGET_NUMERIC) {
      assert.equal(typeof r[f], 'number', `${f} missing on ${r.project_id}|${r.package_type}`);
    }
  }
});

test("a row with no project is dropped, not filed under blank", () => {
  assert.equal(rollUpJobAnalysis([{ ...J6931[0], Project: '   ' }]).length, 0);
});

test("no rows in, no rows out", () => {
  assert.deepEqual(rollUpJobAnalysis([]), []);
  assert.deepEqual(rollUpJobAnalysis(), []);
});
