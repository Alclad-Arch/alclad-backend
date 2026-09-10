// Contract value and budget per job, from ALX_JobAnalysis.
//
// The fixtures are job 3817's four REAL rows, as returned on 2026-09-10. That matters: the grain of
// this inquiry is not obvious — revenue and cost figures sit on different rows, and which side a
// row belongs to depends on its AccountGroupID — and an invented fixture would have encoded my
// assumption about it rather than what MYOB actually sends.
//
// The two numbers that prove the grain is understood are checked against a SECOND inquiry:
// CostsToDate summed is 3,749,975.19 and InvoicedAmt is 3,890,777.47, which are exactly what
// ALX_JobTrans reports as 3817's actual cost and actual income.
import assert from "node:assert/strict";
import test from "node:test";
import {
  rollUpJobAnalysis, scopeForType, BUDGET_SELECT, BUDGET_INQUIRY, BUDGET_NUMERIC, TYPE_TO_SCOPE,
} from "./myobJobAnalysis.js";

/* The tenant's classification, as classifyGroups() returns it. */
const COST = new Set(['STAFF', 'SUBCONT', 'MATERIAL', 'EQUIP', 'LABOUR', 'OTHER', 'CONSULT']);
const INCOME = new Set(['GLAZING', 'CLADDING', 'RECLAD', 'FINS']);
const SETS = { costGroups: COST, incomeGroups: INCOME };

/* Job 3817, verbatim. Padding included — MYOB sends AccountGroupID space-padded. */
const J3817 = [
  { Project: '3817      ', ProjectName: '181 William St & 550 Bourke St', Type: 'R', Stage: 'Completed',
    ProjectManager: 'BENSAIED Anouar, Mr', AccountGroupID: 'RECLAD    ',
    BudgetRevenue: 4011186.35, ContractVariations: 511540.31, ContractValueIncVar: 4522726.66,
    InvoicedAmt: 3890777.47, RetainedAmt: 0, PendingInvoiceAmt: 0, DraftInvoicedAmt: 0,
    BudgetCost: 0, CostsToDate: 0, CostProjection: 0, CostAtCompletion: 0, OpenCommittedAmt: 0 },
  { Project: '3817      ', ProjectName: '181 William St & 550 Bourke St', Type: 'G', Stage: 'Completed',
    ProjectManager: 'BENSAIED Anouar, Mr', AccountGroupID: 'STAFF     ',
    BudgetRevenue: 0, ContractVariations: 0, ContractValueIncVar: 0, InvoicedAmt: 0,
    BudgetCost: 0, CostsToDate: 0, CostProjection: 0, CostAtCompletion: 0, OpenCommittedAmt: 0 },
  { Project: '3817      ', ProjectName: '181 William St & 550 Bourke St', Type: 'C', Stage: 'Completed',
    ProjectManager: 'BENSAIED Anouar, Mr', AccountGroupID: 'STAFF     ',
    BudgetRevenue: 0, ContractVariations: 0, ContractValueIncVar: 0, InvoicedAmt: 0,
    BudgetCost: 0, CostsToDate: 4800, CostProjection: -4800, CostAtCompletion: 0, OpenCommittedAmt: 0 },
  { Project: '3817      ', ProjectName: '181 William St & 550 Bourke St', Type: 'R', Stage: 'Completed',
    ProjectManager: 'BENSAIED Anouar, Mr', AccountGroupID: 'SUBCONT   ',
    BudgetRevenue: 0, ContractVariations: -355478.48, ContractValueIncVar: -3141631.96, InvoicedAmt: 0,
    BudgetCost: 2786153.48, CostsToDate: 3745175.19, CostProjection: -57182.48,
    CostAtCompletion: 3687992.71, OpenCommittedAmt: 0 },
];

const total = (rows, field) => Math.round(rows.reduce((n, r) => n + r[field], 0) * 100) / 100;

// ── the inquiry and its columns ───────────────────────────────────────────
test("reads ALX_JobAnalysis, and asks for the grain plus both sides", () => {
  assert.equal(BUDGET_INQUIRY, 'ALX_JobAnalysis');
  for (const c of ['Project', 'Type', 'AccountGroupID', 'ContractValueIncVar', 'BudgetCost', 'Stage']) {
    assert.ok(BUDGET_SELECT.includes(c), `${c} must be selected`);
  }
  /* AccountGroupID is what decides which side a row's figures belong to — without it every figure
     is unattributable and the roll-up is guesswork. */
  assert.ok(BUDGET_SELECT.includes('AccountGroupID'));
});

// ── THE TWO CROSS-CHECKS AGAINST ALX_JobTrans ────────────────────────────
test("CostsToDate sums to 3817's actual cost, as ALX_JobTrans reports it", () => {
  /* 3,749,975.19 from a different inquiry entirely. Agreement to the cent is what says the grain is
     understood rather than assumed. */
  const { rows } = rollUpJobAnalysis(J3817, SETS);
  assert.equal(total(rows, 'costs_to_date'), 3749975.19);
});

test("InvoicedAmt matches 3817's actual income", () => {
  const { rows } = rollUpJobAnalysis(J3817, SETS);
  assert.equal(total(rows, 'invoiced'), 3890777.47);
});

// ── THE TRAP: ContractValueIncVar is not summable ────────────────────────
test("the contract value comes from INCOME rows only", () => {
  /* Its formula is BudgetGP + ContractVariations, so on a cost row it is nonsense — row four of
     3817 reads -3,141,631.96. Summed over all four rows it gives 1,381,094.70, which is not the
     contract value and would look perfectly plausible on a project card. */
  const { rows } = rollUpJobAnalysis(J3817, SETS);
  assert.equal(total(rows, 'contract_value'), 4522726.66);
  /* Spelled out, so the number this must NEVER be is in the file: */
  const naive = J3817.reduce((n, r) => n + r.ContractValueIncVar, 0);
  assert.equal(Math.round(naive * 100) / 100, 1381094.70, 'the wrong answer, for the record');
});

test("budget revenue and variations likewise come from the income side", () => {
  const { rows } = rollUpJobAnalysis(J3817, SETS);
  assert.equal(total(rows, 'budget_revenue'), 4011186.35);
  /* Note the cost row carries a NEGATIVE variation (-355,478.48). Including it would understate the
     contract by a third of a million. */
  assert.equal(total(rows, 'contract_variations'), 511540.31);
});

test("budget cost and costs come from the expense side", () => {
  const { rows } = rollUpJobAnalysis(J3817, SETS);
  assert.equal(total(rows, 'budget_cost'), 2786153.48);
  assert.equal(total(rows, 'cost_at_completion'), 3687992.71);
});

// ── the grain ─────────────────────────────────────────────────────────────
test("rolls up to project × package type", () => {
  const { rows } = rollUpJobAnalysis(J3817, SETS);
  /* Three types across four rows: R appears twice (income + subcontract cost). */
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.package_type).sort(), ['C', 'G', 'R']);
  const r = rows.find((x) => x.package_type === 'R');
  assert.equal(r.contract_value, 4522726.66, 'the income and cost rows for R combine');
  assert.equal(r.budget_cost, 2786153.48);
  assert.equal(r.source_rows, 2);
});

test("the project id is trimmed — MYOB pads it", () => {
  const { rows } = rollUpJobAnalysis(J3817, SETS);
  assert.ok(rows.every((r) => r.project_id === '3817'), rows.map((r) => r.project_id).join(','));
});

test("descriptive fields take the FIRST non-empty value", () => {
  /* They repeat across a project's rows; first-wins is stable where last-wins depends on row
     order, which the ledger does not guarantee. */
  const { rows } = rollUpJobAnalysis([
    { ...J3817[1], ProjectName: '', ProjectManager: '', Stage: '' },
    J3817[1],
  ], SETS);
  assert.equal(rows[0].project_name, '181 William St & 550 Bourke St');
  assert.equal(rows[0].stage, 'Completed');
});

// ── the package mapping ───────────────────────────────────────────────────
test("Type maps to the hub's scope vocabulary", () => {
  assert.equal(scopeForType('G'), 'Glazing');
  assert.equal(scopeForType('C'), 'Cladding');
  assert.equal(scopeForType('R'), 'Recladding');
  assert.equal(scopeForType('F'), 'Fins');
  assert.deepEqual(Object.keys(TYPE_TO_SCOPE).sort(), ['C', 'F', 'G', 'R']);
});

test("an unrecognised Type is left BLANK, not guessed", () => {
  /* A wrong package silently attributes a contract to the wrong scope, which is worse than an
     unmapped one — that at least shows up as missing. */
  assert.equal(scopeForType('X'), '');
  assert.equal(scopeForType(''), '');
  assert.equal(scopeForType(null), '');
  const { rows } = rollUpJobAnalysis([{ ...J3817[0], Type: 'X' }], SETS);
  assert.equal(rows[0].package_scope, '');
  assert.equal(rows[0].package_type, 'X', 'but the raw letter is kept, so it can be looked into');
});

// ── unclassified groups ───────────────────────────────────────────────────
test("an AccountGroupID in neither set is REPORTED, not guessed", () => {
  /* Either new revenue, which would inflate a contract value, or new cost, which would be missing
     from a budget. Nothing here can tell which. */
  const { rows, unknownGroups } = rollUpJobAnalysis([
    ...J3817,
    { ...J3817[0], AccountGroupID: 'FREIGHT', ContractValueIncVar: 99999 },
  ], SETS);
  assert.deepEqual(unknownGroups, ['FREIGHT']);
  /* And its figures are NOT counted while it is unclassified. */
  assert.equal(total(rows, 'contract_value'), 4522726.66);
});

test("a blank group is reported too", () => {
  const { unknownGroups } = rollUpJobAnalysis([{ ...J3817[0], AccountGroupID: '' }], SETS);
  assert.deepEqual(unknownGroups, ['(blank)']);
});

test("nothing unclassified means an empty list, not null", () => {
  const { unknownGroups } = rollUpJobAnalysis(J3817, SETS);
  assert.deepEqual(unknownGroups, []);
});

// ── zero is not absent ────────────────────────────────────────────────────
test("a zero budget cost is stored as zero — the READER decides it means absent", () => {
  /* Jed 2026-09-10: not all jobs have a cost budget yet. MYOB writes an unpopulated one as 0.00,
     indistinguishable from a real zero, which is why 6931 reports GP 100%. Storing what MYOB says
     and marking it downstream keeps the fact and the interpretation separate. */
  const { rows } = rollUpJobAnalysis([J3817[0]], SETS);
  assert.equal(rows[0].budget_cost, 0);
  assert.equal(rows[0].contract_value, 4522726.66, 'while the revenue side is real');
});

// ── arithmetic safety ─────────────────────────────────────────────────────
test("an unparseable figure contributes nothing rather than NaN", () => {
  const { rows } = rollUpJobAnalysis([
    { ...J3817[0], ContractValueIncVar: 'not a number' },
    { ...J3817[0], ContractValueIncVar: undefined },
    J3817[0],
  ], SETS);
  assert.equal(rows[0].contract_value, 4522726.66, 'the one good row survives intact');
});

test("every numeric field is present on every row, so no reader has to guard", () => {
  const { rows } = rollUpJobAnalysis(J3817, SETS);
  for (const r of rows) {
    for (const f of BUDGET_NUMERIC) {
      assert.equal(typeof r[f], 'number', `${f} missing on ${r.project_id}|${r.package_type}`);
    }
  }
});

test("a row with no project is dropped, not filed under blank", () => {
  const { rows } = rollUpJobAnalysis([{ ...J3817[0], Project: '   ' }], SETS);
  assert.equal(rows.length, 0);
});
