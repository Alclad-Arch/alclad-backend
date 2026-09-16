// Forecast history per cost code, from VelixoReportsPro-CostProjectionDetail.
//
// ⚠ THE FIXTURE IS REAL AND IT IS THE WHOLE POINT. These are all seven revisions of 6163 / 1000101
// exactly as the inquiry returned them on 2026-09-17, and they are the rows the column semantics
// were DERIVED from — every formula below was checked against figures the hub already held and had
// already reconciled to the cent, from a DIFFERENT inquiry:
//
//   JUL 26 V2  ProjectedAmount 12,477  = the cost_at_completion stored for this code
//   JUL 26 V2  Amount           4,227  = the cost_to_complete stored for this code
//
// That is what makes this evidence rather than restatement. myobJobAnalysis.js records what it cost
// to "verify" a formula against another field derived the same way: a wrong contract value lived for
// a month behind two tests that could never have failed.
//
// The fixture also carries both traps on purpose:
//   · the revision NAMES sort JULY before JUNE alphabetically
//   · APRIL and MAY predate the cost budget, reading ~100,000 on a code budgeted 4,023
import assert from "node:assert/strict";
import test from "node:test";
import {
  rollUpProjections, PROJECTION_INQUIRY, PROJECTION_SELECT, PROJECTION_ORDER,
} from "./myobCostProjections.js";

const line = (RevisionID, Amount, ProjectedAmount, VarianceAmount, CompletedPct, LastModifiedDateTime, LineNbr = 1, CostCodeID = '1000101') => ({
  ProjectID: '6163', RevisionID, ClassID: 'TASKCOSTGROUP', AccountGroupID: 'STAFF',
  CostCodeID, InventoryID: '<N/A>', TaskID: '100GLPRELIM',
  Amount, ProjectedAmount, VarianceAmount, CompletedPct, LastModifiedDateTime,
  LineDescription: 'Glazing - Preliminaries - Project Management', LineNbr,
});

/* All seven, in the order the inquiry returned them — which is ALPHABETICAL BY REVISION, so JULY
   arrives before JUNE. Left in that order deliberately: anything that sorts correctly must do so
   from revised_at, and a fixture pre-sorted by date would hide a bug that only bites in production. */
const R6163 = [
  line('APRIL 26 V1', 100000, 100000, 100000, 0, '2026-05-06T04:03:08.242717Z'),
  line('JULY 26 V1', 500, 8750, 4727, 94.29, '2026-08-05T06:57:11.692662Z'),
  line('JULY 26 V2', 4227, 12477, 8454, 66.12, '2026-08-07T03:07:27.160711Z'),
  line('JUNE 26 V1', 500, 6200, 2177, 91.94, '2026-07-09T22:26:38.056727Z'),
  line('JUNE 26 V2', 1000, 6700, 2677, 85.07, '2026-07-10T00:34:21.018903Z'),
  line('JUNE26 V3', 1000, 6700, 2677, 85.07, '2026-07-13T06:30:00.591463Z'),
  line('MAY 26 V1', 95541, 96741, 96741, 1.24, '2026-06-05T01:26:59.599204Z'),
];

const rolled = rollUpProjections(R6163);
const rev = (name) => rolled.find((r) => r.revision === name);

test('the inquiry, select and order are what the sync will ask for', () => {
  assert.equal(PROJECTION_INQUIRY, 'VelixoReportsPro-CostProjectionDetail');
  for (const c of ['ProjectID', 'RevisionID', 'CostCodeID', 'Amount', 'ProjectedAmount',
                   'VarianceAmount', 'CompletedPct', 'LastModifiedDateTime']) {
    assert.ok(PROJECTION_SELECT.includes(c), c);
  }
  /* ProjectID_2 is the INTERNAL id and is deliberately not fetched — we join on the job number, and
     fetching it would invite someone to use it. */
  assert.equal(PROJECTION_SELECT.includes('ProjectID_2'), false);
  assert.equal(PROJECTION_ORDER, 'ProjectID,RevisionID,LineNbr');
});

// ── ⚠ THE SEMANTICS, against figures proved elsewhere ───────────────────────
test('⚠ ProjectedAmount is the FORECAST — JUL 26 V2 is the 12,477 already stored for this code', () => {
  assert.equal(rev('JULY 26 V2').forecast, 12477);
});
test('⚠ Amount is COST TO COMPLETE — JUL 26 V2 is the 4,227 already stored for this code', () => {
  assert.equal(rev('JULY 26 V2').to_complete, 4227);
});
test('⚠ spend at each revision = projected − to complete, on every one of the seven', () => {
  /* The free gift: an implicit snapshot of spend-to-date at each revision, so the ACTUAL trend
     comes with the forecast trend for one subtraction. */
  const expected = {
    'APRIL 26 V1': 0, 'MAY 26 V1': 1200, 'JUNE 26 V1': 5700, 'JUNE 26 V2': 5700,
    'JUNE26 V3': 5700, 'JULY 26 V1': 8250, 'JULY 26 V2': 8250,
  };
  for (const [name, spend] of Object.entries(expected)) {
    assert.equal(rev(name).spend_at, spend, name);
  }
});
test('completed_pct is RECOMPUTED and reproduces MYOB’s own figure on all seven', () => {
  for (const r of R6163) {
    assert.equal(rolled.find((x) => x.revision === r.RevisionID).completed_pct, r.CompletedPct, r.RevisionID);
  }
});
test('…and is null, not zero, where there is no forecast to be a percentage of', () => {
  const [only] = rollUpProjections([line('X', 0, 0, 0, 0, '2026-01-01T00:00:00Z')]);
  assert.equal(only.completed_pct, null);
});

// ── ⚠ TRAP 1: the revision names do not sort chronologically ────────────────
/* revisionTimeline() and biggestMovers() moved to the frontend (src/pm/finOptions.js) — they shape
   STORED rows for a panel and nothing in the sync consumes them, so their tests moved with them to
   tests/engine/finoptions.mjs. This one stays: it is a fact about the DATA, and it is the reason
   revised_at is fetched and stored at all. */
test('⚠ JULY sorts BEFORE JUNE alphabetically — which is why nothing may sort on the name', () => {
  assert.ok('JULY 26 V1' < 'JUNE 26 V1');
  /* So the roll-up must carry a chronological key, or the history cannot be ordered downstream. */
  assert.ok(rolled.every((r) => !!r.revised_at));
});

// ── ⚠ TRAP 2: the pre-budget artefacts ─────────────────────────────────────
test('⚠ APRIL and MAY are flagged pre-budget — variance EQUALS projected, so the budget was 0', () => {
  assert.equal(rev('APRIL 26 V1').pre_budget, true);
  assert.equal(rev('MAY 26 V1').pre_budget, true);
});
test('…and every revision after the budget existed is not', () => {
  for (const n of ['JUNE 26 V1', 'JUNE 26 V2', 'JUNE26 V3', 'JULY 26 V1', 'JULY 26 V2']) {
    assert.equal(rev(n).pre_budget, false, n);
  }
});
test('…variance stays as MYOB reports it — against the budget AS AT that revision, not today’s', () => {
  // 12,477 − 4,023 = 8,454 on the latest; the April figure is against a budget of nothing.
  assert.equal(rev('JULY 26 V2').variance, 8454);
  assert.equal(rev('APRIL 26 V1').variance, 100000);
});
test('an empty line does not flag itself as pre-budget', () => {
  const [z] = rollUpProjections([line('Z', 0, 0, 0, 0, '2026-01-01T00:00:00Z')]);
  assert.equal(z.pre_budget, false);
});

// ── the grain ───────────────────────────────────────────────────────────────
test('⚠ a code on SEVERAL lines of one revision is summed, not overwritten', () => {
  /* The inquiry's own grain is finer than project × revision × code — a code can appear under two
     tasks or account groups, exactly as it does in the cost-code feed. */
  const two = rollUpProjections([
    line('JUNE 26 V1', 400, 4000, 1000, 90, '2026-07-09T00:00:00Z', 1, '2000301'),
    line('JUNE 26 V1', 600, 6000, 2000, 90, '2026-07-09T00:00:01Z', 2, '2000301'),
  ]);
  assert.equal(two.length, 1);
  assert.equal(two[0].forecast, 10000);
  assert.equal(two[0].to_complete, 1000);
  assert.equal(two[0].lines, 2);
  // recomputed from the SUMS, never averaged — a $50 line must not weigh as much as a $50,000 one
  assert.equal(two[0].spend_at, 9000);
  assert.equal(two[0].completed_pct, 90);
  // and the latest timestamp on any line is the revision's
  assert.equal(two[0].revised_at, '2026-07-09T00:00:01Z');
});
test('one row per project × revision × code, and 6163/1000101 gives seven', () => {
  assert.equal(rolled.length, 7);
  const keys = rolled.map((r) => `${r.project_id}|${r.revision}|${r.cost_code}`);
  assert.equal(new Set(keys).size, keys.length);
});
test('the package comes from the cost code, as everywhere else', () => {
  assert.ok(rolled.every((r) => r.package_type === 'G' && r.is_defect === false));
  assert.equal(rev('JULY 26 V2').cost_code_dashed, '100-01-01');
});

// ── the usual refusals ──────────────────────────────────────────────────────
test('rows with no project, no revision or no code are skipped', () => {
  assert.deepEqual(rollUpProjections([{ ProjectID: ' ', RevisionID: 'A', CostCodeID: '1000101' }]), []);
  assert.deepEqual(rollUpProjections([{ ProjectID: '6163', RevisionID: '', CostCodeID: '1000101' }]), []);
  assert.deepEqual(rollUpProjections([{ ProjectID: '6163', RevisionID: 'A', CostCodeID: '' }]), []);
});
test('the revenue/milestone line is excluded, same convention as the cost-code feed', () => {
  assert.deepEqual(rollUpProjections([line('A', 0, 500, 0, 0, '2026-01-01T00:00:00Z', 1, '0000000')]), []);
});
test('a missing or unparseable figure cannot poison a sum', () => {
  const messy = rollUpProjections([
    { ProjectID: '6163', RevisionID: 'A', CostCodeID: '1000101', ProjectedAmount: 100 },
    { ProjectID: '6163', RevisionID: 'A', CostCodeID: '1000101', ProjectedAmount: 'nope', Amount: null },
  ]);
  assert.equal(messy[0].forecast, 100);
  assert.equal(messy[0].to_complete, 0);
  assert.equal(messy[0].lines, 2);
});
test('defect codes are kept in the roll-up but excluded from the job timeline', () => {
  const withDefect = rollUpProjections([
    line('JUNE 26 V1', 100, 1000, 500, 90, '2026-07-09T00:00:00Z', 1, '1000101'),
    line('JUNE 26 V1', 200, 2000, 900, 90, '2026-07-09T00:00:00Z', 2, '4000101'),
  ]);
  assert.equal(withDefect.length, 2);
  assert.equal(withDefect.find((r) => r.cost_code === '4000101').is_defect, true);
  /* Excluding them from a JOB total is the frontend's job now; what matters here is that the flag
     survives the roll-up so it can be excluded at all. */
  assert.equal(withDefect.find((r) => r.cost_code === '1000101').is_defect, false);
});
