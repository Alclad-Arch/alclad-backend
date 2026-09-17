// The ledger, one row per transaction — so a red cost-code bar can be opened and the money behind
// it read: which supplier, which invoice, which employee, which item.
//
// Built from the SAME read as myob_actuals. That table rolls 53,793 ledger rows down to 5,753
// figures per project × cost code × period; this keeps them one-for-one. Two tables, one inquiry,
// one Acumatica session, zero extra requests — the columns are all in ACTUALS_SELECT.
//
// ── ⚠ `Module` IS THE KEY TO READING ANY OF THIS ───────────────────────────────────────────────
//
// ALX_JobTrans carries three quite different kinds of transaction in one shape, and WHICH FIELDS
// ARE POPULATED depends entirely on where the row came from. Verified on job 6163, 2026-09-17:
//
//   Module 'AP'  — A SUPPLIER BILL. Type 'Bill', ReferenceNbr 'B00012906', and SupplierInvNbr
//                  'INV-0359' — the supplier's OWN invoice number. This is the real audit trail:
//                  ANCHORED CONSTRUCTIONS, 32 hours at $100, bill B00012906, their invoice
//                  INV-0359.
//   Module 'IN'  — AN INVENTORY RECEIPT. Reference 'IR003876'. NO SupplierInvNbr, NO Type, NO
//                  ReferenceNbr: goods were received, the bill is a separate later document. A
//                  material line is therefore one step short of an invoice, and saying otherwise
//                  would be inventing a reference.
//   Module null  — LABOUR, from a timecard. Employee 'EP00000031' / EmployeeName 'MATAAC Renante,
//                  Mr', UnitRate 77, UOM HOUR. No supplier at all, and none is implied.
//
// So `source` is derived from Module rather than guessed at from which fields happen to be filled,
// and every consumer can tell "this line has no invoice" from "this line's invoice is missing".
//
// ── ⚠ THE VENDOR NAME IS ITEM MASTER DATA, NOT THE TRANSACTION'S VENDOR ───────────────────────
//
// PreferredVendorName is the vendor on the INVENTORY ITEM — who Alclad would normally buy that item
// from — not who this particular transaction was with. The evidence is that it tracks the item code
// prefix exactly:
//
//   CON-SS10GM      → Concept Aluminium Coatings      CON-DELIVERY → Concept Aluminium Coatings
//   ACA-POWDERCOAT  → AC Aluminium Finishing          SC-AC-1001   → ANCHORED CONSTRUCTIONS
//
// For Alclad's coding that is almost always the real supplier — items are named after the vendor
// they come from, and a subcontract item IS the subcontractor. But it is master data, so a line
// bought from an alternative source would carry a confident and wrong name with nothing on the row
// to say so.
//
// It is therefore stored as `item_vendor_name` and NOT as `supplier_name`, and the UI shows the
// bill reference and the supplier's invoice number beside it — those come from the transaction and
// settle any doubt. A plausible wrong name on a financial page is worse than no name.
//
// ── SIZE ───────────────────────────────────────────────────────────────────────────────────────
//
// ⚠ ~54,000 rows and it tracks MYOB's ledger exactly. It IS swept like the others — every run
// re-reads the whole ledger, so a transaction reversed or re-coded in the ERP disappears here too.
// It is never loaded whole into a browser; the hub reads one job at a time.

const ACTUALS_LABEL = 'ALX_JobTrans';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => String(v ?? '').trim();
/* Null rather than '' for the many fields that are legitimately absent. A blank string reads as
   "known to be empty"; these are "does not apply to this kind of row", which is a different fact
   and the whole reason `source` exists. */
const nul = (v) => {
  const s = str(v);
  return s === '' ? null : s;
};
/* A date without a time. MYOB sends midnight UTC and nothing here cares about the hour; keeping the
   timestamp would invite a timezone bug for no gain. */
const day = (v) => {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/* Where the row came from. Derived from Module, NOT from which fields happen to be populated —
 * inferring it backwards would make an AP bill whose supplier invoice number was left blank look
 * like an inventory receipt. */
export const SOURCE_BY_MODULE = { AP: 'bill', IN: 'receipt' };
export function sourceOf(module) {
  const m = str(module).toUpperCase();
  if (!m) return 'labour';                    // no module = a timecard; see the header
  return SOURCE_BY_MODULE[m] || 'other';      // named, not guessed — an unmapped module is visible
}

export class LedgerGrainError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'LedgerGrainError';
    this.detail = detail;
  }
}

/* One stored row per ledger transaction.
 *
 * ⚠ REFUSES on a duplicate TranID. ACTUALS_ORDER already depends on that column being unique — it
 * is what makes $skip paging deterministic across 108 requests — so a duplicate means either the
 * inquiry changed or the paging repeated a row, and both would silently corrupt the figures in
 * myob_actuals as well. Better a loud nightly failure than a quiet double count. */
export function toLedgerLines(rows = [], syncedAt = null, { costGroups = null } = {}) {
  const out = [];
  const seen = new Set();
  const dupes = [];

  for (const r of rows) {
    const project = str(r.Project);
    if (!project) continue;                   // cannot be attributed to anything
    const tranId = num(r.TranID);
    if (!tranId) continue;                    // without the key there is no row to write

    if (seen.has(tranId)) {
      if (dupes.length < 10) dupes.push(tranId);
      continue;
    }
    seen.add(tranId);

    const source = sourceOf(r.Module);
    out.push({
      project_id: project,
      tran_id: tranId,
      cost_code: str(r.CostCode),
      account_group: str(r.AccountGroup),
      /* ⚠ COST OR REVENUE, FROM THE TENANT'S OWN CLASSIFICATION — never inferred from the sign.
         Alclad books revenue through account groups named after the PACKAGES (GLAZING, CLADDING,
         RECLAD, FINS) as credits, so a breakdown that sums blind reports cost netted against
         revenue. That is not hypothetical: it is what made one project read 10,734,945.75 on the
         first dry run of this feed, and it came back on 6163's vendor panel as percentages adding
         to 146% and a "not attributable" line of −86,131.14.
         Null costGroups means the caller did not classify, and then nothing is claimed either way —
         is_cost stays false rather than guessing, and a consumer filtering on it gets nothing
         rather than everything. */
      is_cost: costGroups ? costGroups.has(str(r.AccountGroup)) : false,
      cost_code_grp: str(r.CostCodeGrp),
      fin_period: str(r.FinPeriod),
      source,
      /* The document, where there is one. On a bill these three together are the audit trail; on a
         receipt only `reference` is set; on labour none are. */
      doc_type: nul(r.Type),
      doc_ref: nul(r.ReferenceNbr),
      reference: nul(r.Reference),
      /* ⚠ THE SUPPLIER'S OWN INVOICE NUMBER — only ever on an AP row. This is the one field that
         answers "which invoice", and it is null on every receipt and every timecard. */
      supplier_inv_nbr: nul(r.SupplierInvNbr),
      /* ⚠ ITEM MASTER DATA — see the header. Deliberately NOT called supplier_name. */
      item_vendor: nul(r.PreferredVendor),
      item_vendor_name: nul(r.PreferredVendorName),
      employee: nul(r.Employee),
      employee_name: nul(r.EmployeeName),
      item_code: nul(r.InventoryItem),
      item_desc: nul(r.InventoryItemDescr),
      item_class: nul(r.InventoryClass),
      description: nul(r.Description),
      tran_date: day(r.TranDate),
      /* MYOB's own document date, which can PRECEDE the posting date — 15 May worked, 22 May
         posted. Both are kept: one answers "when did this happen", the other "when did it hit the
         ledger", and a period comparison needs the second. */
      doc_date: day(r.Date),
      qty: num(r.Qty),
      amount: num(r.Amount),
      unit_rate: num(r.UnitRate),
      uom: nul(r.UOM),
      ...(syncedAt ? { synced_at: syncedAt } : {}),
    });
  }

  if (dupes.length) {
    throw new LedgerGrainError(
      `${ACTUALS_LABEL} returned duplicate TranID(s) — paging repeated a row, or the inquiry's ` +
      `grain changed. myob_actuals sums the same rows, so this would double-count there too. ` +
      `Refusing to write. First ${dupes.length}: ${dupes.join(', ')}`,
      dupes,
    );
  }
  return out;
}

/* ⚠ spendByVendor() USED TO LIVE HERE and was moved to the frontend (src/pm/finOptions.js), for the
   same reason revisionTimeline() was: it shapes rows that are already STORED, for a panel, and
   nothing in the sync consumes it. A copy in each repo is two rules for one question. This module's
   job ends at turning ledger rows into storable ones. */
