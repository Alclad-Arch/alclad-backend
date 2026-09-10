// Contract value, budget and forecast per job, from the MYOB Generic Inquiry ALX_JobAnalysis.
//
// This is the other half of what the hub needs. ALX_JobTrans says what a job has SPENT and BILLED;
// this says what it is WORTH and what it was meant to cost. Together they make an expected-versus-
// actual comparison instead of a bare figure.
//
// ── THE GRAIN, and it is not obvious ────────────────────────────────────────────────────────────
//
// One row per project × cost bucket, with the REVENUE and COST figures on DIFFERENT rows. Job 3817
// on 2026-09-10 returned four:
//
//   AccountGroupID  Type  BudgetRevenue  Variations  Invoiced    BudgetCost   CostsToDate
//   RECLAD (income)  R     4,011,186.35   511,540.31  3,890,777.47        0             0
//   STAFF            G                 0           0            0         0             0
//   STAFF            C                 0           0            0         0         4,800
//   SUBCONT          R                 0           0            0  2,786,153.48  3,745,175.19
//
// So a column is only meaningful on the side it belongs to, and which side a row is depends on
// whether its AccountGroupID is an Income or an Expense group — the SAME classification already
// read from VelixoReportsPro-AccountGroups for the actuals feed.
//
// ⚠ ContractValueIncVar IS NOT SUMMABLE ACROSS ROWS. Its formula is BudgetGP + ContractVariations
// (verified on all four rows above), so on an income row it equals revenue plus variations — the
// contract value — and on a cost row it is nonsense: row four reads -3,141,631.96. Summed over all
// four it gives 1,381,094.70, which is not the contract value and would look entirely plausible on
// a project card. Taken over income rows only it gives 4,522,726.66, which is right.
//
// ── WHY THIS IS TRUSTWORTHY ─────────────────────────────────────────────────────────────────────
//
// CostsToDate summed across all four rows is 3,749,975.19 — exactly what ALX_JobTrans independently
// reports as 3817's cost — and InvoicedAmt is 3,890,777.47, exactly its actual income. Two separate
// inquiries agreeing to the cent on both sides is what says the grain above is understood rather
// than guessed.
//
// ── ZERO IS NOT THE SAME AS ABSENT ──────────────────────────────────────────────────────────────
//
// Jed, 2026-09-10: "Not all jobs currently have a cost budget. Not all have been created yet."
// MYOB writes an unpopulated budget as 0.00, indistinguishable from a real zero, which is why 6931
// reports GP 100.00% — revenue with no cost. So a consumer must treat a zero cost budget as MISSING
// and decline to compute a GP from it, exactly as an unbilled job declines to show a margin. The
// roll-up stores what MYOB says; the decision belongs to the reader, and the view marks it.

export const BUDGET_INQUIRY = 'ALX_JobAnalysis';

/* $select, so a column added to the inquiry cannot change what we store. Project and Type are the
   grain; AccountGroupID decides which side each row's figures belong to. */
export const BUDGET_SELECT = [
  'Project', 'ProjectName', 'Type', 'Stage', 'ProjectManager', 'AccountGroupID',
  // revenue side
  'BudgetRevenue', 'ContractVariations', 'ContractValueIncVar', 'InvoicedAmt',
  'RetainedAmt', 'PendingInvoiceAmt', 'DraftInvoicedAmt',
  // cost side
  'BudgetCost', 'CostsToDate', 'CostProjection', 'CostAtCompletion', 'OpenCommittedAmt',
];

/* Ordered on a unique-ish key so $skip paging is deterministic — see the $orderby note in
   myobOdataRead.js. ProjectTaskID is not in $select, so Project is the best available; the inquiry
   is small (one row per project × bucket, not per transaction) so a page boundary landing inside a
   project is the only risk, and ordering by Project removes it. */
export const BUDGET_ORDER = 'Project';

/* Columns that only mean anything on an INCOME row. */
const REVENUE_FIELDS = {
  BudgetRevenue: 'budget_revenue',
  ContractVariations: 'contract_variations',
  ContractValueIncVar: 'contract_value',
  InvoicedAmt: 'invoiced',
  RetainedAmt: 'retained',
  PendingInvoiceAmt: 'pending_invoice',
  DraftInvoicedAmt: 'draft_invoiced',
};

/* Columns that only mean anything on an EXPENSE row. */
const COST_FIELDS = {
  BudgetCost: 'budget_cost',
  CostsToDate: 'costs_to_date',
  CostProjection: 'cost_projection',
  CostAtCompletion: 'cost_at_completion',
  OpenCommittedAmt: 'open_committed',
};

export const BUDGET_NUMERIC = [...Object.values(REVENUE_FIELDS), ...Object.values(COST_FIELDS)];

/* A number that cannot poison a sum. Number(null) is 0 but Number(undefined) is NaN, and one NaN
   silently destroys a whole total. */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* Which package a row belongs to. MYOB's Type is a single letter and the hub's scopes are words;
   this is the only place the two vocabularies meet.
 *
 * Derived from live rows: job 3817 returned Type R with AccountGroup 'RECLADDING', Type G with
 * 'GLAZING', Type C with 'CLADDING'. F is included for Fins by the same pattern — the income group
 * FINS exists in the tenant — but has NOT been seen in data, so it is marked as inferred.
 * An unrecognised letter is kept as-is rather than guessed at: a wrong package is worse than an
 * unmapped one, because it silently attributes a contract to the wrong scope. */
export const TYPE_TO_SCOPE = {
  G: 'Glazing',
  C: 'Cladding',
  R: 'Recladding',
  F: 'Fins',            // inferred from the FINS income group, not yet observed in ALX_JobAnalysis
};
export const scopeForType = (t) => TYPE_TO_SCOPE[String(t ?? '').trim().toUpperCase()] || '';

/* Roll ALX_JobAnalysis rows up to project × package type.
 *
 * `costGroups` and `incomeGroups` are the sets from classifyGroups() — the same tenant
 * classification the actuals feed uses, so the two cannot disagree about what STAFF or GLAZING is.
 *
 * Returns { rows, unknownGroups }. An AccountGroupID in neither set is REPORTED rather than
 * guessed: it is either new revenue, which would inflate a contract value, or new cost, which would
 * be missing from a budget, and nothing here can tell which. The caller refuses the sync. */
export function rollUpJobAnalysis(rows = [], { costGroups = null, incomeGroups = null } = {}) {
  const by = new Map();
  const unknown = new Set();

  for (const r of rows) {
    const project = String(r.Project ?? '').trim();
    if (!project) continue;              // a row with no project cannot be attributed to anything
    const group = String(r.AccountGroupID ?? '').trim();
    const isIncome = !!incomeGroups && incomeGroups.has(group);
    const isCost = !!costGroups && costGroups.has(group);
    if (!isIncome && !isCost) { unknown.add(group || '(blank)'); continue; }

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
       first-wins is stable where last-wins depends on the ledger's row order. */
    if (!cur.project_name) cur.project_name = String(r.ProjectName ?? '').trim();
    if (!cur.project_manager) cur.project_manager = String(r.ProjectManager ?? '').trim();
    if (!cur.stage) cur.stage = String(r.Stage ?? '').trim();

    const map = isIncome ? REVENUE_FIELDS : COST_FIELDS;
    for (const [src, dest] of Object.entries(map)) cur[dest] += num(r[src]);
    cur.source_rows += 1;
  }

  /* Rounded to cents at the end, not per row: rounding each addend first is how a total drifts away
     from the ledger by a few cents per hundred lines. */
  const out = [...by.values()].map((v) => {
    const o = { ...v };
    for (const f of BUDGET_NUMERIC) o[f] = Math.round(o[f] * 100) / 100;
    return o;
  });
  return { rows: out, unknownGroups: [...unknown].sort() };
}
