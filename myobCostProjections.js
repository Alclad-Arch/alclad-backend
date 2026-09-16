// Forecast HISTORY per cost code, from the MYOB Generic Inquiry VelixoReportsPro-CostProjectionDetail.
//
// myobCostCodes.js reads where a code is forecast to land TODAY. This reads where it was forecast to
// land at every revision before that — which is the difference between a number and a trend. A
// forecast nobody has revised is worse than no forecast, because it is believed; and a forecast
// revised five times in four months, swinging by an order of magnitude, says something a single
// snapshot cannot.
//
// ── ⚠ DO NOT ASK FOR ALX_PMCostProjectionLines ────────────────────────────────────────────────
//
// That inquiry returns 403 and a permission request for it was drafted twice, in September and
// again on 2026-09-17. It is not needed: THIS inquiry is already readable, already exposed, and
// carries more (a per-line description and a completion percentage the ALX one was not asked for).
// Third time the same lesson has paid on this feed, after ALX_JobAnalysis_Detail — **probe for an
// existing sibling before requesting a permission.**
//
// ── ⚠ COLUMN NAMES LIE ACROSS INQUIRIES IN THIS TENANT ────────────────────────────────────────
//
// In VelixoReportsPro-CostBudgets, `ProjectID` is an INTERNAL id, `ProjectID_2` is the job number,
// and `CostCodeID` is a surrogate ("300"). Here it is the exact reverse: `ProjectID` is the job
// number, `ProjectID_2` is internal (230 for 6163 — which is what ALX_JobAnalysis_Detail reports
// for the same job, so two inquiries agree), and `CostCodeID` is the real 7-digit business code
// ("1000101"). The `ID` suffix means nothing. Read the values, never the names.
//
// ⚠ Padding is inconsistent within one column: "0018      " came back padded and "6163" did not.
// Trim both sides, always.
//
// ── THE SEMANTICS, DERIVED AND VERIFIED — NOT GUESSED ─────────────────────────────────────────
//
// All seven revisions of 6163 / 1000101 were pulled and every formula checked against figures the
// hub already holds and had already reconciled to the cent:
//
//   ProjectedAmount  = COST AT COMPLETION, the forecast.  JUL 26 V2 = 12,477 — exactly the
//                      cost_at_completion stored for that code.
//   Amount           = COST TO COMPLETE, what is left.    JUL 26 V2 = 4,227 — exactly the
//                      cost_to_complete stored for that code.
//   CompletedPct     = spend ÷ projected.                 ✓ on all seven rows.
//   VarianceAmount   = projected − the budget AS AT THAT REVISION (not today's budget).
//   → SPEND AT THAT REVISION = ProjectedAmount − Amount.  Consistent on every pair, which is a
//     free gift: each revision carries an implicit snapshot of spend-to-date, so the ACTUAL trend
//     comes with the forecast trend.
//
// This is deliberately not the kind of check that let a wrong contract formula live for a month:
// the figures were matched against a DIFFERENT inquiry's stored output, not against another field
// derived the same way. See myobJobAnalysis.js for what that mistake cost.
//
// ── ⚠ TWO TRAPS ───────────────────────────────────────────────────────────────────────────────
//
// 1. REVISION NAMES DO NOT SORT CHRONOLOGICALLY. "JULY 26 V1" sorts BEFORE "JUNE 26 V1"
//    alphabetically. This is the FinPeriodID lexical-sort bug again — the one that displayed a
//    period span backwards on the project card. ORDER BY revised_at, NEVER by revision.
// 2. THE EARLIEST REVISIONS ARE PRE-BUDGET ARTEFACTS. 6163/1000101 reads ~100,000 in April and May
//    on a code budgeted 4,023, because the cost budget did not exist yet. Plotted naively the trend
//    is dominated by noise and reads as a catastrophic forecast collapse that never happened. They
//    are FLAGGED rather than dropped — a code that was guessed at 100,000 before anyone budgeted it
//    is a fact worth keeping, just not one to draw a line through.

export const PROJECTION_INQUIRY = 'VelixoReportsPro-CostProjectionDetail';

/* $select, so a column added to the inquiry cannot change what we store.
 *
 * ProjectID_2 is deliberately NOT requested: it is the internal id, we join on the job number, and
 * fetching it would invite someone to use it. Quantity columns are skipped — the hub deals in money
 * and a projected quantity has no consumer. */
export const PROJECTION_SELECT = [
  'ProjectID', 'RevisionID', 'CostCodeID', 'AccountGroupID', 'TaskID',
  'Amount', 'ProjectedAmount', 'VarianceAmount', 'CompletedPct',
  'LastModifiedDateTime', 'LineDescription', 'LineNbr',
];

/* Ordered so $skip paging is deterministic. Project + revision + line is unique, which matters more
   here than on the smaller feeds: this inquiry pages many times and an unordered read can repeat one
   row and drop another. */
export const PROJECTION_ORDER = 'ProjectID,RevisionID,LineNbr';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => String(v ?? '').trim();
const round2 = (n) => Math.round(n * 100) / 100;

/* The same prefix→package rule the cost-code feed uses, imported rather than repeated so the two
   tables cannot disagree about which package a code belongs to. */
import { packageForCostCode, dashedCostCode } from './myobCostCodes.js';

/* Roll the inquiry up to project × revision × cost code.
 *
 * ⚠ SUMMED, because the inquiry's own grain is finer — a code can appear on several lines of one
 * revision under different tasks or account groups, exactly as it does in the cost-code feed
 * (6163's 1000205 sits under both OTHER and STAFF). CompletedPct cannot be summed, so it is
 * RECOMPUTED from the summed figures after the fact; averaging percentages would weight a $50 line
 * the same as a $50,000 one. */
export function rollUpProjections(rows = []) {
  const by = new Map();

  for (const r of rows) {
    const project = str(r.ProjectID);
    if (!project) continue;
    const revision = str(r.RevisionID);
    if (!revision) continue;                    // a line belonging to no revision cannot be placed
    const code = str(r.CostCodeID);
    /* The all-zero code is the revenue/milestone line, same convention as the cost-code feed. */
    if (!code || code === '0000000') continue;

    const key = `${project}|${revision}|${code}`;
    let cur = by.get(key);
    if (!cur) {
      const { package_type, is_defect } = packageForCostCode(code);
      cur = {
        project_id: project,
        revision,
        cost_code: code,
        cost_code_dashed: dashedCostCode(code),
        package_type,
        is_defect,
        cost_code_desc: '',
        account_group: '',
        project_task: '',
        forecast: 0,          // ProjectedAmount — cost at completion
        to_complete: 0,       // Amount — what was left at that revision
        variance: 0,          // ProjectedAmount − budget AS AT that revision
        lines: 0,
        revised_at: null,
      };
      by.set(key, cur);
    }
    if (!cur.cost_code_desc) cur.cost_code_desc = str(r.LineDescription);
    if (!cur.account_group) cur.account_group = str(r.AccountGroupID);
    if (!cur.project_task) cur.project_task = str(r.TaskID);

    cur.forecast += num(r.ProjectedAmount);
    cur.to_complete += num(r.Amount);
    cur.variance += num(r.VarianceAmount);
    cur.lines += 1;
    /* LATEST wins. A revision's lines are written together, but a later edit to one line is the
       revision's real timestamp — and this column is the ONLY chronological key there is. */
    const at = str(r.LastModifiedDateTime);
    if (at && (!cur.revised_at || at > cur.revised_at)) cur.revised_at = at;
  }

  return [...by.values()].map((v) => {
    const o = { ...v };
    o.forecast = round2(o.forecast);
    o.to_complete = round2(o.to_complete);
    o.variance = round2(o.variance);
    /* ⚠ THE FREE GIFT: spend at that revision. Verified on every pair of 6163/1000101's seven
       revisions. It is what turns this from a forecast history into a forecast-AND-actual history,
       and it costs one subtraction. */
    o.spend_at = round2(o.forecast - o.to_complete);
    /* Recomputed, never averaged — see the note above. Null rather than 0 where there is no
       forecast to be a percentage of: 0% and "no basis" are different statements. */
    o.completed_pct = o.forecast !== 0 ? round2((o.spend_at / o.forecast) * 100) : null;
    /* ⚠ PRE-BUDGET, DERIVED RATHER THAN GUESSED. variance = projected − budget-at-revision, so
       variance EQUAL to projected means the budget was zero when this revision was written. That is
       exactly the April/May artefact on 6163/1000101 — ~100,000 forecast on a code nobody had
       budgeted yet. Flagged, not dropped: it is a real fact, just not a point to draw a line
       through. Both must be non-zero, or an empty line would flag itself. */
    o.pre_budget = o.forecast !== 0 && o.variance === o.forecast;
    return o;
  });
}

/* ⚠ revisionTimeline() and biggestMovers() USED TO LIVE HERE and were moved to the frontend
   (src/pm/finOptions.js) on 2026-09-17. They shape STORED rows for a panel; nothing in the sync
   consumed them, and a copy in each repo would have been two rules for one question — the mistake
   this codebase has paid for more than once. This module's job ends at the roll-up. */
