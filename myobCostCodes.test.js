// Budget, actual and forecast per cost code, from ALX_JobAnalysis_Detail.
//
// THE FIXTURE IS REAL — all 46 rows job 6163 returned on 2026-09-16, transcribed from the probe
// including the rows that are entirely zero and the ones that look like duplicates. That matters
// more than usual here: the two things this module has to get right (which rows are revenue, and
// that one cost code can arrive on several rows) are BOTH invisible in a tidy invented fixture, and
// both are present in these.
//
// ⚠ THE SIX RECONCILIATION ASSERTIONS ARE THE POINT OF THIS SUITE, and they are not circular. The
// targets come from ALX_JobAnalysis — a DIFFERENT inquiry at a DIFFERENT grain, read separately —
// so they can disagree with these rows and the test can genuinely fail. myobJobAnalysis.js records
// what it cost to learn that lesson: a contract-value formula was "verified" for a month against a
// field computed the same way, and neither of its two tests could ever have failed.
//
//   GLAZING   BudgetCost 151,365.50   CostsToDate  82,457.48   CostAtCompletion 142,191.57
//   CLADDING  BudgetCost 323,003.38   CostsToDate 114,597.57   CostAtCompletion 259,079.38
import assert from "node:assert/strict";
import test from "node:test";
import {
  rollUpCostCodes, packageForCostCode, dashedCostCode, reconcileAgainstPackages,
  CostCodeGrainError, COSTCODE_SELECT, COSTCODE_INQUIRY, COSTCODE_NUMERIC, REVENUE_COST_CODE,
} from "./myobCostCodes.js";

/* Job 6163 Hale Oakleigh South, verbatim. Columns trimmed to the ones this module reads, but NO
   rows dropped — the eleven revenue rows and the repeated codes are the fixture's whole value.
   Project is space-padded exactly as the wire returns it. */
const row = (AccountGroup, ProjectTask, CostCode, BudgetCost, CostsToDate, CostAtCompletion,
             CostProjection, OpenCommittedAmt, CostToComplete, OriginalBudget, CostCodeDescription) =>
  ({ Project: '6163      ', AccountGroup, ProjectTask, CostCode, CostCode_2: CostCode,
     CostCodeDescription, BudgetCost, CostsToDate, CostAtCompletion, CostProjection,
     OpenCommittedAmt, CostToComplete, OriginalBudget });

const J6163 = [
  // ── the eleven REVENUE rows: cost code all zeroes, and note Type would have said RECLADDING ──
  row('CLADDING', 'CM1', '0000000', 0, 0, 0, 0, 0, 0, 0, 'Vitracore G2 Cladding Package - Office 1'),
  row('CLADDING', 'V01', '0000000', 0, 0, 0, 0, 0, 0, 0, 'V01 - Vitracore G2 Cladding Package'),
  row('CLADDING', 'CM2', '0000000', 0, 0, 0, 0, 0, 0, 0, 'Vitracore G2 Cladding Package - Office 2'),
  row('CLADDING', 'CM3', '0000000', 0, 0, 0, 0, 0, 0, 0, 'Vitracore G2 Cladding Package - Office 3'),
  row('CLADDING', 'CM4', '0000000', 0, 0, 0, 0, 0, 0, 0, 'Vitracore G2 Cladding Package - Office 4'),
  row('CLADDING', 'V02', '0000000', 0, 0, 0, 0, 0, 0, 0, 'V02 - Supply and install additional cladding'),
  row('GLAZING', 'GM1', '0000000', 0, 0, 0, 0, 0, 0, 0, 'Aluminium Glazing Package - Office 1'),
  row('GLAZING', 'GM2', '0000000', 0, 0, 0, 0, 0, 0, 0, 'Aluminium Glazing Package - Office 2'),
  row('GLAZING', 'GM3', '0000000', 0, 0, 0, 0, 0, 0, 0, 'Aluminium Glazing Package - Office 3'),
  row('GLAZING', 'GM4', '0000000', 0, 0, 0, 0, 0, 0, 0, 'Aluminium Glazing Package - Office 4'),
  row('GLAZING', 'V04', '0000000', 0, 0, 0, 0, 0, 0, 0, 'V04 - Supply and install additional framing'),
  // ── GLAZING cost rows ──
  row('CONSULT', '100GLPRELIM', '1000103', 0, 3181.82, 3181.82, 0, 0, 0, 0, 'Glazing - Preliminaries - Consultant'),
  row('EQUIP', '101GLMANUF', '1000204', 0, 0, 0, 0, 0, 0, 0, 'Glazing - Manufacturing - Plant'),
  row('EQUIP', '102GLONSITE', '1000306', 2000, 2250.11, 2000, -250.11, 0, 1880, 2000, 'Glazing - On Site Activities - Plant'),
  row('LABOUR', '101GLMANUF', '1000206', 0, 0, 0, 0, 0, 0, 0, 'Glazing - Manufacturing - Labour Hire'),
  row('MATERIAL', '101GLMANUF', '1000202', 37510, 14844.15, 32740, 17895.85, 0, 20000, 37510, 'Glazing - Manufacturing - Glass'),
  row('MATERIAL', '101GLMANUF', '1000203', 30947.50, 29769.11, 30565, 695.89, 100, 2225.37, 30565, 'Glazing - Manufacturing - Other Materials'),
  row('MATERIAL', '102GLONSITE', '1000304', 0, 0, 0, 0, 0, 0, 0, 'Glazing - On Site Activities - Glass'),
  row('MATERIAL', '102GLONSITE', '1000305', 0, 0, 0, 0, 0, 0, 0, 'Glazing - On Site Activities - Other Materials'),
  row('OTHER', '101GLMANUF', '1000205', 3270, 200, 1100, 900, 0, 1000, 3000, 'Glazing - Manufacturing - Delivery'),
  row('STAFF', '100GLPRELIM', '1000101', 4023, 11250, 12477, 1227, 0, 4227, 4023, 'Glazing - Preliminaries - Project Management'),
  row('STAFF', '100GLPRELIM', '1000102', 12620, 1790.25, 4790.25, 3000, 0, 3000, 12620, 'Glazing - Preliminaries - Internal Design'),
  row('STAFF', '100GLPRELIM', '1000104', 1490, 997.50, 997.50, 0, 0, 0, 1490, 'Glazing - Preliminaries - Project Team'),
  row('STAFF', '100GLPRELIM', '1000105', 0, 0, 0, 0, 0, 0, 0, 'Glazing - Preliminaries - Travel / Accommodation'),
  row('STAFF', '101GLMANUF', '1000201', 12445, 4992, 8640, 3648, 0, 8000, 12445, 'Glazing - Manufacturing - Labour'),
  // ⚠ 1000205 A SECOND TIME, under STAFF rather than OTHER — trap 2, and the forecast here is 0
  //   against a real 1,632.00 spent, which is trap 5.
  row('STAFF', '101GLMANUF', '1000205', 0, 1632, 0, -1632, 0, 0, 0, 'Glazing - Manufacturing - Delivery'),
  row('SUBCONT', '102GLONSITE', '1000301', 25200, 4150, 23840, 19690, 0, 23840, 23840, 'Glazing - On Site Activities - Installation'),
  row('SUBCONT', '102GLONSITE', '1000302', 1000, 0, 1000, 1000, 0, 1000, 1000, 'Glazing - On Site Activities - Caulking'),
  row('SUBCONT', '102GLONSITE', '1000303', 20860, 7400.54, 20860, 13459.46, 0, 13459.21, 20860, 'Glazing - On Site Activities - Glazing'),
  // ── CLADDING cost rows ──
  row('CONSULT', '200CLPRELIM', '2000103', 0, 0, 0, 0, 0, 0, 0, 'Cladding - Preliminaries - Consultant'),
  row('EQUIP', '202CLONSITE', '2000304', 9763.88, 1622.11, 5726.88, 4104.77, 0, 5726.88, 5726.88, 'Cladding - On Site Activities - Plant'),
  row('LABOUR', '201CLMANUF', '2000206', 0, 0, 0, 0, 0, 0, 0, 'Cladding - Manufacturing - Labour Hire'),
  row('MATERIAL', '201CLMANUF', '2000202', 101640, 60359.38, 74970, 12185.62, 2425, 58845, 74970, 'Cladding - Manufacturing - Sheet'),
  row('MATERIAL', '201CLMANUF', '2000203', 27359, 7800.83, 19992, 12191.17, 0, 16931.48, 19992, 'Cladding - Manufacturing - Other Materials'),
  row('MATERIAL', '202CLONSITE', '2000303', 0, 0, 0, 0, 0, 0, 0, 'Cladding - On Site Activities - Other Materials'),
  row('OTHER', '201CLMANUF', '2000205', 9304, 300, 6664, 6364, 0, 6664, 6664, 'Cladding - Manufacturing - Delivery'),
  row('STAFF', '200CLPRELIM', '2000101', 8469, 0, 6247, 6247, 0, 6247, 6247, 'Cladding - Preliminaries - Project Management'),
  row('STAFF', '200CLPRELIM', '2000102', 7566, 6750.25, 5581, -1169.25, 0, 2019.75, 5581, 'Cladding - Preliminaries - Internal Design'),
  row('STAFF', '200CLPRELIM', '2000104', 0, 0, 0, 0, 0, 0, 0, 'Cladding - Preliminaries - Project Team'),
  row('STAFF', '200CLPRELIM', '2000105', 0, 0, 0, 0, 0, 0, 0, 'Cladding - Preliminaries - Travel / Accommodation'),
  row('STAFF', '201CLMANUF', '2000201', 36138, 11876, 26656, 14780, 0, 26656, 26656, 'Cladding - Manufacturing - Labour'),
  row('STAFF', '201CLMANUF', '2000204', 0, 0, 0, 0, 0, 0, 0, 'Cladding - Manufacturing - Plant'),
  // ⚠ 2000205 a second time, and 2000101 a second time under a DIFFERENT TASK — trap 2 again
  row('STAFF', '201CLMANUF', '2000205', 0, 1344, 0, -1344, 0, 0, 0, 'Cladding - Manufacturing - Delivery'),
  row('STAFF', '202CLONSITE', '2000101', 0, 450, 0, -450, 0, 0, 0, 'Cladding - Preliminaries - Project Management'),
  row('SUBCONT', '202CLONSITE', '2000301', 97354, 24095, 94500, -5375, 75780, 0, 70805, 'Cladding - On Site Activities - Installation'),
  row('SUBCONT', '202CLONSITE', '2000302', 25409.50, 0, 18742.50, 18742.50, 0, 18742.50, 18742.50, 'Cladding - On Site Activities - Caulking'),
];

/* What ALX_JobAnalysis reports for the same job — the shape rollUpJobAnalysis produces. THESE ARE
   THE TARGETS, and they came from the other inquiry. */
const PACKAGE_6163 = [
  { project_id: '6163', package_type: 'G', budget_cost: 151365.50, costs_to_date: 82457.48, cost_at_completion: 142191.57 },
  { project_id: '6163', package_type: 'C', budget_cost: 323003.38, costs_to_date: 114597.57, cost_at_completion: 259079.38 },
];

const rolled = rollUpCostCodes(J6163);
const find = (code) => rolled.find((r) => r.cost_code === code);
const sumOf = (pkg, field) => Math.round(
  rolled.filter((r) => r.package_type === pkg).reduce((a, r) => a + r[field], 0) * 100) / 100;

test('the fixture is all 46 rows as returned, not a tidied subset', () => {
  assert.equal(J6163.length, 46);
  assert.equal(J6163.filter((r) => r.CostCode === REVENUE_COST_CODE).length, 11);
});

// ── ⚠ THE RECONCILIATION — six sums against a different inquiry ────────────────────────────────
test('GLAZING · per-code BudgetCost sums to what ALX_JobAnalysis reports', () => {
  assert.equal(sumOf('G', 'budget_cost'), 151365.50);
});
test('GLAZING · per-code CostsToDate sums to what ALX_JobAnalysis reports', () => {
  assert.equal(sumOf('G', 'costs_to_date'), 82457.48);
});
test('GLAZING · per-code CostAtCompletion sums to what ALX_JobAnalysis reports', () => {
  assert.equal(sumOf('G', 'cost_at_completion'), 142191.57);
});
test('CLADDING · per-code BudgetCost sums to what ALX_JobAnalysis reports', () => {
  assert.equal(sumOf('C', 'budget_cost'), 323003.38);
});
test('CLADDING · per-code CostsToDate sums to what ALX_JobAnalysis reports', () => {
  assert.equal(sumOf('C', 'costs_to_date'), 114597.57);
});
test('CLADDING · per-code CostAtCompletion sums to what ALX_JobAnalysis reports', () => {
  assert.equal(sumOf('C', 'cost_at_completion'), 259079.38);
});

test('reconcileAgainstPackages agrees, on the same two reads', () => {
  const res = reconcileAgainstPackages(rolled, PACKAGE_6163);
  assert.deepEqual(res.drifts, []);
  assert.equal(res.ok, true);
  assert.deepEqual(res.unmatched, []);
  assert.equal(res.compared, 2);
});

test('⚠ and it REPORTS a drift rather than hiding one', () => {
  const wrong = [{ ...PACKAGE_6163[0], budget_cost: 151365.51 }, PACKAGE_6163[1]];
  const res = reconcileAgainstPackages(rolled, wrong);
  assert.equal(res.ok, false);
  assert.equal(res.drifts.length, 1);
  assert.equal(res.drifts[0].field, 'budget_cost');
  assert.equal(res.drifts[0].diff, -0.01);
});

// ── trap 1: Type is never read ─────────────────────────────────────────────────────────────────
test('⚠ the package comes from the CODE, not Type — 6163 gets no Recladding', () => {
  /* Every revenue row in the fixture carries Type RECLADDING on the wire. If Type were read, this
     job would sprout a package it does not have and real money would sit in it. */
  assert.deepEqual([...new Set(rolled.map((r) => r.package_type))].sort(), ['C', 'G']);
  assert.equal(COSTCODE_SELECT.includes('Type'), false);
});

test('packageForCostCode maps every series, and refuses to guess', () => {
  assert.deepEqual(packageForCostCode('1000101'), { package_type: 'G', is_defect: false });
  assert.deepEqual(packageForCostCode('2000301'), { package_type: 'C', is_defect: false });
  assert.deepEqual(packageForCostCode('3000101'), { package_type: 'R', is_defect: false });
  assert.deepEqual(packageForCostCode('7000101'), { package_type: 'F', is_defect: false });
  // the defect series — same package, flagged
  assert.deepEqual(packageForCostCode('4000101'), { package_type: 'G', is_defect: true });
  assert.deepEqual(packageForCostCode('5000101'), { package_type: 'C', is_defect: true });
  assert.deepEqual(packageForCostCode('6000101'), { package_type: 'R', is_defect: true });
  assert.deepEqual(packageForCostCode('8000101'), { package_type: 'F', is_defect: true });
  // an unrecognised prefix is BLANK, never a guess
  assert.deepEqual(packageForCostCode('9000101'), { package_type: '', is_defect: false });
  assert.deepEqual(packageForCostCode(''), { package_type: '', is_defect: false });
  assert.deepEqual(packageForCostCode(null), { package_type: '', is_defect: false });
});

// ── trap 2: the grain is finer than per-cost-code ──────────────────────────────────────────────
test('⚠ a code arriving on SEVERAL rows is summed, not overwritten', () => {
  /* 1000205 Glazing Delivery: 3,270 budget under OTHER, 0 under STAFF; 200 spent on one and
     1,632 on the other. Overwriting instead of summing loses 1,632 of real spend. */
  const g = find('1000205');
  assert.equal(g.source_rows, 2);
  assert.equal(g.budget_cost, 3270);
  assert.equal(g.costs_to_date, 1832);
  assert.equal(g.cost_at_completion, 1100);
});

test('⚠ the same code under two TASKS is one row, not two', () => {
  // 2000101 sits under 200CLPRELIM and 202CLONSITE. Task is descriptive; it is not part of the key.
  const c = find('2000101');
  assert.equal(c.source_rows, 2);
  assert.equal(c.costs_to_date, 450);
  assert.equal(c.budget_cost, 8469);
  assert.equal(c.project_task, '200CLPRELIM');   // first non-empty wins, and it is NOT a key
});

test('one row per project × package × code, and the count is right', () => {
  const keys = rolled.map((r) => `${r.project_id}|${r.package_type}|${r.cost_code}`);
  assert.equal(new Set(keys).size, keys.length);
  // 35 cost rows in the fixture, of which three codes appear twice → 32 distinct
  assert.equal(rolled.length, 32);
});

// ── trap 3: the CostCode_2 assertion ───────────────────────────────────────────────────────────
test('⚠ REFUSES when CostCode and CostCode_2 disagree', () => {
  const poisoned = [...J6163, { ...J6163[20], CostCode: '1000101', CostCode_2: '1000306' }];
  assert.throws(() => rollUpCostCodes(poisoned), (e) => {
    assert.ok(e instanceof CostCodeGrainError);
    assert.match(e.message, /CostCode_2 disagree/);
    assert.equal(e.detail.length, 1);
    return true;
  });
});

test('a blank CostCode_2 is not treated as a disagreement', () => {
  // The column could be dropped from the inquiry; absent is not the same as contradictory.
  const blank = J6163.map((r) => ({ ...r, CostCode_2: '' }));
  assert.equal(rollUpCostCodes(blank).length, 32);
});

// ── trap 4: CostProjection is not the forecast ─────────────────────────────────────────────────
test('⚠ CostAtCompletion = CostsToDate + CostProjection + OpenCommittedAmt, on every fixture row', () => {
  for (const r of J6163) {
    const lhs = Math.round(r.CostAtCompletion * 100);
    const rhs = Math.round((r.CostsToDate + r.CostProjection + r.OpenCommittedAmt) * 100);
    assert.equal(lhs, rhs, `${r.CostCode} ${r.AccountGroup}: ${r.CostAtCompletion} vs ${r.CostsToDate}+${r.CostProjection}+${r.OpenCommittedAmt}`);
  }
});

test('⚠ CostToComplete is NOT derivable from the others', () => {
  /* 1000306 is the counter-example that keeps anyone from computing one from the other:
     CostAtCompletion − CostsToDate = −250.11, while MYOB's CostToComplete says 1,880.00. */
  const r = find('1000306');
  /* ⚠ ROUNDED, and the rounding is the point. Every figure is STORED to the cent, but subtracting
     two of them in JS reintroduces float error immediately — this line read -250.11000000000013
     before the round. Any consumer computing a variance must round the RESULT; rounded inputs do
     not give a rounded answer. barTitle already does this; a SQL view must too. */
  assert.equal(Math.round((r.cost_at_completion - r.costs_to_date) * 100) / 100, -250.11);
  assert.equal(r.cost_to_complete, 1880);
});

test('CostProjection is stored as returned, negatives and all', () => {
  assert.equal(find('2000301').cost_projection, -5375);
  assert.equal(find('1000306').cost_projection, -250.11);
});

// ── trap 5: zero is not absent ─────────────────────────────────────────────────────────────────
test('⚠ a zero forecast against real spend reads as NO FORECAST, not a forecast of zero', () => {
  // 1000204 Glazing Plant: nothing budgeted, nothing spent, nothing forecast.
  const empty = find('1000204');
  assert.equal(empty.has_budget, false);
  assert.equal(empty.has_forecast, false);
  // 1000101 has all three.
  const full = find('1000101');
  assert.equal(full.has_budget, true);
  assert.equal(full.has_forecast, true);
});

test('⚠ an aggregated code can forecast BELOW its own actual — the bar must survive it', () => {
  const g = find('1000205');
  assert.ok(g.cost_at_completion < g.costs_to_date, `${g.cost_at_completion} < ${g.costs_to_date}`);
  assert.equal(g.has_forecast, true);
});

// ── the revenue rows ───────────────────────────────────────────────────────────────────────────
test('⚠ the milestone rows are excluded, and excluding them hides no money', () => {
  assert.equal(rolled.some((r) => r.cost_code === REVENUE_COST_CODE), false);
  const dropped = J6163.filter((r) => r.CostCode === REVENUE_COST_CODE);
  assert.equal(dropped.length, 11);
  // every cost figure on every one of them is zero — that is WHY they can be dropped
  const total = dropped.reduce((a, r) => a + r.BudgetCost + r.CostsToDate + r.CostAtCompletion, 0);
  assert.equal(total, 0);
});

// ── the shape written to the table ─────────────────────────────────────────────────────────────
test('Project is trimmed — the wire pads it to ten characters', () => {
  assert.equal(J6163[0].Project, '6163      ');
  assert.ok(rolled.every((r) => r.project_id === '6163'));
});

test('the dashed code joins to the Budget Calculator list', () => {
  assert.equal(find('1000101').cost_code_dashed, '100-01-01');
  assert.equal(dashedCostCode('2000304'), '200-03-04');
  // anything not exactly seven digits is left alone rather than sliced into a false shape
  assert.equal(dashedCostCode('123'), '123');
  assert.equal(dashedCostCode('100-01-01'), '100-01-01');
  assert.equal(dashedCostCode(''), '');
});

test('the description rides along, so a bar is not labelled 1000105', () => {
  assert.equal(find('1000101').cost_code_desc, 'Glazing - Preliminaries - Project Management');
});

test('every numeric column is present and finite on every row', () => {
  for (const r of rolled) {
    for (const f of COSTCODE_NUMERIC) {
      assert.equal(typeof r[f], 'number', `${r.cost_code}.${f}`);
      assert.ok(Number.isFinite(r[f]), `${r.cost_code}.${f}`);
    }
  }
});

test('a missing or unparseable figure cannot poison a sum', () => {
  const messy = [
    { Project: '9999', CostCode: '1000101', CostCode_2: '1000101', BudgetCost: 100 },
    { Project: '9999', CostCode: '1000101', CostCode_2: '1000101', BudgetCost: 'not a number', CostsToDate: null },
  ];
  const [r] = rollUpCostCodes(messy);
  assert.equal(r.budget_cost, 100);
  assert.equal(r.costs_to_date, 0);
  assert.equal(r.source_rows, 2);
});

test('a row with no project is skipped, not attributed to a blank job', () => {
  const orphan = [{ Project: '   ', CostCode: '1000101', CostCode_2: '1000101', BudgetCost: 999 }];
  assert.deepEqual(rollUpCostCodes(orphan), []);
});

test('the inquiry name and select are what the sync will ask for', () => {
  assert.equal(COSTCODE_INQUIRY, 'ALX_JobAnalysis_Detail');
  for (const c of ['Project', 'CostCode', 'CostCode_2', 'CostCodeDescription', 'BudgetCost',
                   'CostsToDate', 'CostAtCompletion']) {
    assert.ok(COSTCODE_SELECT.includes(c), c);
  }
});
