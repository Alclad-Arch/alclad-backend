// Contract value, budget and forecast per job, from the MYOB Generic Inquiry ALX_JobAnalysis.
//
// This is the other half of what the hub needs. ALX_JobTrans says what a job has SPENT and BILLED;
// this says what it is WORTH, what it was meant to cost, and where MYOB expects it to land.
//
// ── THE GRAIN: ONE ROW PER SLICE, AND EVERY FIGURE IS ADDITIVE ──────────────────────────────────
//
// One row per project × task × cost code, each carrying its OWN contribution — not job-level totals
// repeated. So the columns sum, and two independent cross-checks prove it:
//
//   job 3817   sum(CostsToDate) = 3,749,975.19  = myob_actuals.actual_cost      ✓ to the cent
//   job 3817   sum(InvoicedAmt) = 3,890,777.47  = myob_actuals.income_amount    ✓ to the cent
//
// AN EARLIER VERSION SPLIT THE COLUMNS BY SIDE, reading revenue only from rows whose AccountGroupID
// was an Income group and cost only from Expense rows. Job 3817 happens to be arranged that way, so
// it looked right. It is not the rule: job 6931's single row carries BudgetRevenue 69,110 with
// AccountGroupID SUBCONT — an EXPENSE group — and job 0087 carries revenue AND cost on one SUBCONT
// row. The split silently discarded the contract value of all but 5 of 165 jobs. Do not reintroduce
// it; sum, and let the zeroes be zeroes.
//
// ── ⚠ ContractValueIncVar IS NOT THE CONTRACT VALUE, DESPITE THE NAME ──────────────────────────
//
// Its formula, verified on every row seen: BudgetRevenue − BudgetCost + ContractVariations. That is
// GROSS PROFIT including variations. It coincides with the contract value only when BudgetCost is
// zero on the row, which is exactly the case job 6931 and 3817's first row present — which is how
// the name went unchallenged.
//
//   job 0087   BudgetGP 280,583.51 + Variations 5,953.51 = 286,537.02 = ContractValueIncVar
//              Revenue 292,315.00 + Variations 5,953.51 = 298,268.51 = the contract value
//
// So the column is ignored entirely and the contract value is computed as
// BudgetRevenue + ContractVariations, which is how MYOB's own Projects screen states it:
// Original Contract Value + Revised Variation Value = Revised Contract Value. Verified on 6931:
// 69,110 + 0 = 69,110, matching the screen.
//
// ⚠ STILL UNVERIFIED: job 3817 carries a NEGATIVE variation (−355,478.48) on a cost row alongside
// +511,540.31 on its revenue row. Netted, its contract reads 4,167,248.18. Whether MYOB's screen
// agrees has not been checked — a single-row job cannot show it. The components are stored
// separately so this is checkable and correctable without another sync.
//
// ── ⚠ ZERO IS NOT ABSENT ────────────────────────────────────────────────────────────────────────
//
// Jed, 2026-09-10: "Not all jobs currently have a cost budget. Not all have been created yet."
// MYOB writes an unpopulated budget as 0.00, indistinguishable from a real zero — which is why its
// own screen reports 6931 at GP 100%: revenue with no cost. So a consumer must treat a zero cost
// budget as MISSING and decline to compute a GP from it. The roll-up stores what MYOB says; the
// view marks it with has_cost_budget and nulls the GP.

export const BUDGET_INQUIRY = 'ALX_JobAnalysis';

/* $select, so a column added to the inquiry cannot change what we store.
 *
 * ContractValueIncVar is deliberately NOT requested. Fetching it would invite someone to use it,
 * and the one thing it must never be used for is the contract value. */
export const BUDGET_SELECT = [
  'Project', 'ProjectName', 'Type', 'Stage', 'ProjectManager',
  // what the job is worth
  'BudgetRevenue', 'ContractVariations',
  // what it should cost
  'BudgetCost',
  // what has happened — cross-checked against ALX_JobTrans
  'InvoicedAmt', 'CostsToDate', 'RetainedAmt', 'PendingInvoiceAmt', 'DraftInvoicedAmt',
  // where MYOB expects it to land
  'ForecastGP', 'CostAtCompletion', 'CostProjection', 'OpenCommittedAmt',
];

/* Ordered so $skip paging is deterministic — see the $orderby note in myobOdataRead.js. The
   inquiry is small (one row per project × task × cost code, ~171 rows for the whole company) so a
   single page covers it, but an unordered read is undefined regardless of size. */
export const BUDGET_ORDER = 'Project';

/* Every column that is summed, mapped to its stored name. All additive — see the grain note.
 *
 * ⚠ ADDING ONE HERE NEEDS A MIGRATION. These names are written straight into
 * public.myob_project_budget, so a field added here without a column added there fails the sync at
 * the first upsert:
 *
 *     SYNC FAILED: myob_project_budget upsert failed after 0 row(s):
 *     Could not find the 'forecast_gp' column of 'myob_project_budget' in the schema cache
 *
 * That happened on 2026-09-10 when ForecastGP was added after the table was written. It fails
 * loudly and before either sweep, so nothing is lost — but it fails at 1am on a nightly run, and
 * the hub then shows yesterday's figures until someone reads the log. A column here and a column
 * there, in the same change. */
const SUM_FIELDS = {
  BudgetRevenue: 'budget_revenue',
  ContractVariations: 'contract_variations',
  BudgetCost: 'budget_cost',
  InvoicedAmt: 'invoiced',
  CostsToDate: 'costs_to_date',
  RetainedAmt: 'retained',
  PendingInvoiceAmt: 'pending_invoice',
  DraftInvoicedAmt: 'draft_invoiced',
  ForecastGP: 'forecast_gp',
  CostAtCompletion: 'cost_at_completion',
  CostProjection: 'cost_projection',
  OpenCommittedAmt: 'open_committed',
};

/* contract_value is DERIVED, not read — see the ContractValueIncVar note above. */
export const BUDGET_NUMERIC = [...Object.values(SUM_FIELDS), 'contract_value'];

/* A number that cannot poison a sum. Number(null) is 0 but Number(undefined) is NaN, and one NaN
   silently destroys a whole total. */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* Which package a row belongs to. MYOB's Type is a single letter and the hub's scopes are words;
 * this is the only place the two vocabularies meet.
 *
 * Observed in live rows: Type C on job 6931 with AccountGroup 'CLADDING', Type R on 3817 with
 * 'RECLADDING', Type G with 'GLAZING'. F is included for Fins by the same pattern — the FINS income
 * group exists in the tenant — but has NOT been seen in this inquiry, so it is inferred.
 *
 * An unrecognised letter stays BLANK rather than being guessed: a wrong package silently attributes
 * a contract to the wrong scope, which is worse than an unmapped one because it looks answered. */
export const TYPE_TO_SCOPE = {
  G: 'Glazing',
  C: 'Cladding',
  R: 'Recladding',
  F: 'Fins',            // inferred from the FINS income group, not yet observed here
};
export const scopeForType = (t) => TYPE_TO_SCOPE[String(t ?? '').trim().toUpperCase()] || '';

/* Roll ALX_JobAnalysis rows up to project × package type.
 *
 * No account-group classification is needed or used: every figure is additive and belongs to the
 * row it is on, whatever that row's AccountGroupID says. An earlier version passed the classifi-
 * cation in and threw away most of the contract values for it. */
export function rollUpJobAnalysis(rows = []) {
  const by = new Map();

  for (const r of rows) {
    const project = String(r.Project ?? '').trim();
    if (!project) continue;              // a row with no project cannot be attributed to anything
    const type = String(r.Type ?? '').trim().toUpperCase();
    const key = `${project}|${type}`;
    let cur = by.get(key);
    if (!cur) {
      cur = {
        project_id: project,
        package_type: type,
        package_scope: scopeForType(type),
        project_name: '',
        project_manager: '',
        stage: '',
        source_rows: 0,
      };
      for (const f of BUDGET_NUMERIC) cur[f] = 0;
      by.set(key, cur);
    }
    /* First non-empty wins for the descriptive fields. They repeat across a project's rows, and
       first-wins is stable where last-wins depends on the ledger's row order. ProjectManager can be
       null (it is on 6931), so this also keeps a later row's name from being lost to an earlier
       blank one. */
    if (!cur.project_name) cur.project_name = String(r.ProjectName ?? '').trim();
    if (!cur.project_manager) cur.project_manager = String(r.ProjectManager ?? '').trim();
    if (!cur.stage) cur.stage = String(r.Stage ?? '').trim();

    for (const [src, dest] of Object.entries(SUM_FIELDS)) cur[dest] += num(r[src]);
    cur.source_rows += 1;
  }

  /* Rounded to cents at the end, not per row: rounding each addend first is how a total drifts away
     from the ledger by a few cents per hundred lines. */
  return [...by.values()].map((v) => {
    const o = { ...v };
    /* THE CONTRACT VALUE, derived. Original contract plus approved variations, which is how MYOB's
       own screen states it (Original Contract Value + Revised Variation Value = Revised Contract
       Value). Verified on 6931: 69,110 + 0 = 69,110. */
    o.contract_value = o.budget_revenue + o.contract_variations;
    for (const f of BUDGET_NUMERIC) o[f] = Math.round(o[f] * 100) / 100;
    return o;
  });
}
