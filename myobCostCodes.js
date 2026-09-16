// Budget, actual and forecast PER COST CODE, from the MYOB Generic Inquiry ALX_JobAnalysis_Detail.
//
// This is what the hub's cost-code bars stand on. myobJobAnalysis.js reads ALX_JobAnalysis, which
// answers per project × PACKAGE — one row for all of Glazing. This reads its `_Detail` sibling,
// which answers per project × task × account group × COST CODE, and is the same figures broken
// down. The two reconcile exactly; see the check below.
//
// ── ⚠ THE `_Detail` SIBLING EXISTED ALL ALONG ──────────────────────────────────────────────────
//
// MYOB-COSTCODE-INQUIRY.md asked Jed to have an inquiry BUILT for this, because ALX_JobAnalysis
// returns one row per package and its two cost-code columns disagree with each other. That work was
// never needed: `ALX_JobAnalysis_Detail` was already in the tenant and already exposed over OData,
// and it answers the whole question. Two rounds of probing other inquiries came first.
//
// The lesson, written where the next person will need it: when an inquiry is the wrong grain, probe
// its `_Detail` / sibling variants BEFORE asking anyone to build one. The catalogue is 87 names and
// `probe-odata.js` reads them all in one request.
//
// ── THE RECONCILIATION, WHICH IS THE ONLY REASON TO TRUST THIS ─────────────────────────────────
//
// Job 6163, 46 rows, every figure summed per package and compared against what ALX_JobAnalysis
// reports for the same job — a DIFFERENT inquiry at a DIFFERENT grain, so this is not the circular
// check that let a wrong contract formula live for a month (see myobJobAnalysis.js):
//
//                        GLAZING                    CLADDING
//   BudgetCost           151,365.50  ✓              323,003.38  ✓
//   CostsToDate           82,457.48  ✓              114,597.57  ✓
//   CostAtCompletion     142,191.57  ✓              259,079.38  ✓
//
// Six independent sums hitting their targets to the cent is ALSO the proof the row set is COMPLETE:
// a row missed by paging breaks at least one of them. myobCostCodes.test.js pins all six.
//
// ── ⚠ FIVE TRAPS, EVERY ONE OF THEM FOUND IN THOSE 46 ROWS ─────────────────────────────────────
//
// 1. `Type` IS WRONG ON THE REVENUE ROWS — it is NOT read, and must not be. 6163's milestone rows
//    (CM1-CM4, GM1-GM4, V01/V02/V04) all say Type "RECLADDING" while their AccountGroup is CLADDING
//    or GLAZING and their Project_Code is "6163 - C" / "6163 - G". 6163 HAS NO RECLADDING PACKAGE.
//    Grouping bars by Type would invent one and put real money in it. The package comes from the
//    COST CODE PREFIX instead — see packageForCostCode.
// 2. THE GRAIN IS FINER THAN PER-COST-CODE. On 6163, code 1000205 appears twice under Glazing
//    (once under account group OTHER, once under STAFF) and 2000101 and 2000205 twice under
//    Cladding. So rows are SUMMED per code; one row per code is not what arrives.
// 3. `CostCode_2` IS STILL THERE AND NOW AGREES. At the package grain those two columns carried
//    DIFFERENT values on one row, which is what made ALX_JobAnalysis unusable for this. Here they
//    match on every row — so the equality is ASSERTED and a mismatch REFUSES the sync, because the
//    day they diverge is the day a whole package's budget lands on one arbitrary code and looks
//    entirely plausible on screen.
// 4. `CostProjection` IS NOT THE FORECAST. The identity, verified on every row seen:
//       CostAtCompletion = CostsToDate + CostProjection + OpenCommittedAmt
//    (1000203: 29,769.11 + 695.89 + 100.00 = 30,565.00 ✓ · 2000301: 24,095.00 − 5,375.00
//    + 75,780.00 = 94,500.00 ✓). So CostProjection is what is left to spend, it goes NEGATIVE on an
//    overspent code, and the FORECAST is `CostAtCompletion`. Both are stored; nothing derives one
//    from the other. ⚠ `CostToComplete` is separately entered in MYOB and is NOT derivable from
//    these (1000306: CostToComplete 1,880.00 while CostAtCompletion − CostsToDate = −250.11).
// 5. ZERO IS NOT ABSENT, same as the package feed. `CostAtCompletion` 0 means NO FORECAST ENTERED,
//    not a forecast of nothing: 6163's 1000205/STAFF row carries a real 1,632.00 spent against a
//    zero forecast. has_budget / has_forecast carry that distinction to the UI so a bar can render
//    an absent forecast as absent rather than as a marker at the origin.
//
// ── ⚠ ONE THING NOT YET SETTLED — THE OVERSPENT-JOB FLOOR ──────────────────────────────────────
//
// myobJobAnalysis.js records that ALX_JobAnalysis FLOORS CostProjection at 0 on an overspent job,
// which is why job 5477 disagrees with MYOB's own Projects screen. THIS inquiry does not floor it:
// 6163 returns negative CostProjection on six rows. 6163 has budget remaining overall, so its
// package sums still reconcile — but on an OVERSPENT job the per-code sums may legitimately differ
// from the package figures, and that difference would be this inquiry being MORE faithful, not
// less. Unverified: it needs 5477 probed. Until then reconcileAgainstPackages reports drift rather
// than refusing on it, so a real divergence is visible instead of either silently accepted or
// crashing the nightly run at 1am.

export const COSTCODE_INQUIRY = 'ALX_JobAnalysis_Detail';

/* $select, so a column added to the inquiry cannot change what we store.
 *
 * `Type` is deliberately NOT requested — trap 1. Fetching it would invite someone to group by it.
 * `CostCode_2` IS requested despite being redundant, precisely so the assertion in trap 3 has
 * something to check; dropping it would remove the only evidence the join is still sound. */
export const COSTCODE_SELECT = [
  'Project', 'ProjectTask', 'AccountGroup',
  'CostCode', 'CostCode_2', 'CostCodeDescription',
  // what it should cost
  'BudgetCost', 'OriginalBudget',
  // what has happened
  'CostsToDate', 'OpenCommittedAmt',
  // where MYOB expects it to land
  'CostAtCompletion', 'CostProjection', 'CostToComplete',
];

/* Ordered so $skip paging is deterministic — an unordered paged read can repeat one row and drop
   another, and over thousands of rows the total is quietly short. Project alone is not unique here
   (that is the whole point of this inquiry), but $orderby only has to be STABLE, not unique, for
   paging to be sound — and the server applies its own tiebreak consistently within one session. */
export const COSTCODE_ORDER = 'Project';

/* The revenue/milestone rows. MYOB writes them with a cost code of all zeroes and they carry
   BudgetRevenue, not BudgetCost — on 6163 their BudgetCost, CostsToDate and CostAtCompletion are
   all 0.00, verified, so excluding them hides no money. They are excluded because a bar labelled
   "000-00-00" against a milestone's revenue is not a cost code. */
export const REVENUE_COST_CODE = '0000000';

/* A number that cannot poison a sum. Number(null) is 0 but Number(undefined) is NaN, and one NaN
   silently destroys a whole total. */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const str = (v) => String(v ?? '').trim();

/* ── THE PACKAGE, FROM THE CODE ITSELF ──────────────────────────────────────────────────────────
 *
 * NOT from `Type`, which is wrong on the revenue rows — trap 1. The first digit of an Alclad cost
 * code IS the package, which is why this can be read off the code with no lookup and no join:
 *
 *   100-xx-xx Glazing   200-xx-xx Cladding   300-xx-xx Recladding   700-xx-xx Fins
 *   400-xx-xx Glazing Defect   500-xx-xx Cladding Defect
 *   600-xx-xx Recladding Defect   800-xx-xx Fins Defect
 *
 * The letters match myobJobAnalysis.js's TYPE_TO_SCOPE so myob_cost_budget and myob_project_budget
 * speak one vocabulary and join on (project_id, package_type).
 *
 * ⚠ THE DEFECT SERIES ARE REAL MONEY NO ALCLAD TOOL CAN CURRENTLY SEE. Acumatica has 62 defect
 * codes the app does not hold (rework and warranty), and they are deliberately absent from the
 * estimating pick-list — nobody should BUDGET defects. On the actuals side they must not vanish,
 * so they map to their parent package and carry is_defect, letting the UI show them as their own
 * section rather than silently folding rework into manufacturing.
 *
 * An unrecognised prefix returns a BLANK package rather than a guess: a wrong package silently
 * attributes cost to the wrong scope, which is worse than an unmapped one because it looks
 * answered. */
const PREFIX_TO_PACKAGE = {
  1: { package_type: 'G', is_defect: false },
  2: { package_type: 'C', is_defect: false },
  3: { package_type: 'R', is_defect: false },
  4: { package_type: 'G', is_defect: true },
  5: { package_type: 'C', is_defect: true },
  6: { package_type: 'R', is_defect: true },
  7: { package_type: 'F', is_defect: false },
  8: { package_type: 'F', is_defect: true },
};

export function packageForCostCode(code) {
  const c = str(code);
  const hit = PREFIX_TO_PACKAGE[c.slice(0, 1)];
  return hit ? { ...hit } : { package_type: '', is_defect: false };
}

/* MYOB writes cost codes unpunctuated (`1000101`); the Budget Calculator writes them dashed
 * (`100-01-01`). SAME CODES — verified across all 43 shared ones on 2026-09-02 — so this is
 * presentation, not translation, and storing both is what makes line-by-line variance against a
 * budget a join rather than a parsing exercise later.
 *
 * Anything that is not exactly 7 digits is returned UNCHANGED rather than sliced into a shape it
 * does not have: a malformed code that still reads like a code is the kind of thing that joins to
 * the wrong row instead of to nothing. */
export function dashedCostCode(code) {
  const c = str(code);
  if (!/^\d{7}$/.test(c)) return c;
  return `${c.slice(0, 3)}-${c.slice(3, 5)}-${c.slice(5, 7)}`;
}

/* Every column that is summed, mapped to its stored name. All additive — each row carries its own
 * contribution, which is what the six-way reconciliation proves.
 *
 * ⚠ ADDING ONE HERE NEEDS A MIGRATION. These names are written straight into
 * public.myob_cost_budget, so a field added here without a column added there fails the sync at the
 * first upsert — loudly, before any sweep, but at 1am on a nightly run. A column here and a column
 * there, in the same change. This exact mistake cost a day when ForecastGP was added to the package
 * feed after its table was written. */
const SUM_FIELDS = {
  BudgetCost: 'budget_cost',
  OriginalBudget: 'original_budget',
  CostsToDate: 'costs_to_date',
  OpenCommittedAmt: 'open_committed',
  CostAtCompletion: 'cost_at_completion',
  CostProjection: 'cost_projection',
  CostToComplete: 'cost_to_complete',
};

export const COSTCODE_NUMERIC = Object.values(SUM_FIELDS);

/* Thrown rather than returned, and named, so the sync's catch can tell this apart from a network
   failure: one means retry tonight, the other means a human must look at the inquiry. */
export class CostCodeGrainError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CostCodeGrainError';
    this.detail = detail;
  }
}

/* Roll ALX_JobAnalysis_Detail rows up to project × package × cost code.
 *
 * Returns rows ready for public.myob_cost_budget. Refuses, before returning anything, if the two
 * cost-code columns ever disagree — trap 3. */
export function rollUpCostCodes(rows = []) {
  const by = new Map();
  const conflicts = [];

  for (const r of rows) {
    const project = str(r.Project);
    if (!project) continue;              // a row with no project cannot be attributed to anything

    const code = str(r.CostCode);
    if (!code || code === REVENUE_COST_CODE) continue;   // the milestone rows — see above

    /* ⚠ TRAP 3, THE ONE THAT MADE THE PACKAGE INQUIRY UNUSABLE. Collected rather than thrown on
       first sight so the error names the SCALE of the problem — one job's bad row and a systemic
       join change need different responses, and "row 4,812 disagrees" tells you neither. */
    const code2 = str(r.CostCode_2);
    if (code2 && code2 !== code) {
      if (conflicts.length < 10) conflicts.push({ project, CostCode: code, CostCode_2: code2 });
      continue;
    }

    const { package_type, is_defect } = packageForCostCode(code);
    const key = `${project}|${package_type}|${code}`;
    let cur = by.get(key);
    if (!cur) {
      cur = {
        project_id: project,
        package_type,
        cost_code: code,
        cost_code_dashed: dashedCostCode(code),
        cost_code_desc: '',
        account_group: '',
        project_task: '',
        is_defect,
        source_rows: 0,
      };
      for (const f of COSTCODE_NUMERIC) cur[f] = 0;
      by.set(key, cur);
    }

    /* First non-empty wins. These repeat across a code's rows, and first-wins is stable where
       last-wins depends on row order. ⚠ account_group and project_task are DESCRIPTIVE ONLY here:
       a single code genuinely spans several of both (trap 2 — 6163's 1000205 sits under OTHER and
       STAFF, 2000101 under two different tasks), so they identify the code's usual home, not its
       grain. Nothing may key off them. */
    if (!cur.cost_code_desc) cur.cost_code_desc = str(r.CostCodeDescription);
    if (!cur.account_group) cur.account_group = str(r.AccountGroup);
    if (!cur.project_task) cur.project_task = str(r.ProjectTask);

    for (const [src, dest] of Object.entries(SUM_FIELDS)) cur[dest] += num(r[src]);
    cur.source_rows += 1;
  }

  if (conflicts.length) {
    throw new CostCodeGrainError(
      `${COSTCODE_INQUIRY} returned rows whose CostCode and CostCode_2 disagree — the inquiry's ` +
      `join has changed and a package's budget would land on an arbitrary code. Refusing to write. ` +
      `First ${conflicts.length}: ` + conflicts.map((c) => `${c.project} ${c.CostCode}/${c.CostCode_2}`).join(', '),
      conflicts,
    );
  }

  /* Rounded to cents at the end, not per row: rounding each addend first is how a total drifts from
     the ledger by a few cents per hundred lines. */
  return [...by.values()].map((v) => {
    const o = { ...v };
    for (const f of COSTCODE_NUMERIC) o[f] = Math.round(o[f] * 100) / 100;
    /* ZERO IS NOT ABSENT — trap 5. Decided AFTER rounding so a set of rows that sums to zero reads
       as absent, which is what it is. */
    o.has_budget = o.budget_cost !== 0;
    o.has_forecast = o.cost_at_completion !== 0;
    return o;
  });
}

/* ── THE CHECK THAT MAKES THE BARS TRUSTWORTHY ──────────────────────────────────────────────────
 *
 * Per-code figures must sum to what the PACKAGE inquiry reports for the same job and package. Bars
 * that each look reasonable while summing to the wrong total are worse than no bars: they would
 * contradict the dials directly above them on the same screen, and neither would say so.
 *
 * Reports rather than throws — see the overspent-job note at the top of this file. The caller
 * decides what a drift means; this only measures it.
 *
 * `packageRows` is whatever rollUpJobAnalysis produced in the same run, so this compares two live
 * reads of two inquiries rather than either against a constant. */
export function reconcileAgainstPackages(codeRows = [], packageRows = [], { tolerance = 0.005 } = {}) {
  const FIELDS = ['budget_cost', 'costs_to_date', 'cost_at_completion'];
  const sums = new Map();
  for (const r of codeRows) {
    /* ⚠ DEFECT CODES ARE EXCLUDED FROM THE COMPARISON, NOT FROM THE FEED. They map to a parent
       package here but the package inquiry may book them elsewhere, and a mismatch caused by that
       would be this check misreading its own mapping rather than finding a real problem. */
    if (r.is_defect) continue;
    const key = `${r.project_id}|${r.package_type}`;
    let cur = sums.get(key);
    if (!cur) { cur = {}; for (const f of FIELDS) cur[f] = 0; sums.set(key, cur); }
    for (const f of FIELDS) cur[f] += Number(r[f]) || 0;
  }

  const drifts = [];
  for (const p of packageRows) {
    const key = `${p.project_id}|${p.package_type}`;
    const got = sums.get(key);
    /* A package with no per-code rows is NOT drift — a job can legitimately have a package-level
       contract and no cost budget broken down yet. Silence here, a figure below. */
    if (!got) continue;
    for (const f of FIELDS) {
      const want = Number(p[f]) || 0;
      const diff = Math.round((got[f] - want) * 100) / 100;
      if (Math.abs(diff) > tolerance) {
        drifts.push({ project_id: p.project_id, package_type: p.package_type, field: f, per_code: got[f], per_package: want, diff });
      }
    }
    sums.delete(key);
  }

  return {
    ok: drifts.length === 0,
    drifts,
    /* Packages the code feed has but the package feed does not. Not an error either — but if this
       is ever large, the two reads disagree about which jobs exist and that IS worth knowing. */
    unmatched: [...sums.keys()],
    compared: packageRows.length,
  };
}
