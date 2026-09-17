// The ledger at transaction grain — what a red cost-code bar opens into.
//
// ⚠ THE FIXTURE IS THREE REAL ROWS OF JOB 6163, one of each KIND, because the whole difficulty of
// this feed is that ALX_JobTrans carries three quite different transactions in one shape and which
// fields are populated depends entirely on where the row came from. A fixture of one kind would
// have proved nothing and would have let "supplier invoice" be wired to a column that is null on
// two thirds of the ledger.
//
//   AP     a subcontractor bill — Type 'Bill', ReferenceNbr B00012906, SupplierInvNbr 'INV-0359'
//   IN     an inventory receipt — Reference 'IR003876', and NO supplier invoice at all
//   (none) labour from a timecard — EmployeeName, UnitRate 77/hour, and no supplier of any kind
import assert from "node:assert/strict";
import test from "node:test";
import { toLedgerLines, sourceOf, LedgerGrainError } from "./myobLedgerLines.js";
import { ACTUALS_SELECT } from "./myobOdataRead.js";

/* A SUBCONTRACTOR BILL. The complete audit trail: who, their invoice, our bill, hours and rate. */
const BILL = {
  Project: '6163', TranID: 54002, CostCode: '2000301', AccountGroup: 'SUBCONT',
  CostCodeGrp: 'CLADDING', FinPeriod: '022027', Module: 'AP',
  Type: 'Bill', ReferenceNbr: 'B00012906', Reference: 'B00012906', SupplierInvNbr: 'INV-0359',
  PreferredVendor: 'S0000419', PreferredVendorName: 'ANCHORED CONSTRUCTIONS P / L.',
  Employee: null, EmployeeName: null,
  InventoryItem: 'SC-AC-1001', InventoryItemDescr: 'Anchored Construction @$100/hour',
  InventoryClass: 'SUBCON', Description: 'Anchored Construction @$100/hour',
  TranDate: '2026-08-10T00:00:00Z', Date: '2026-08-10T00:00:00Z',
  Qty: 32, Amount: 3200, UnitRate: 0, UOM: 'HOUR',
};
/* AN INVENTORY RECEIPT. Goods in; the bill is a separate later document, so there is no supplier
   invoice number and saying otherwise would be inventing one. */
const RECEIPT = {
  Project: '6163', TranID: 50607, CostCode: '1000203', AccountGroup: 'MATERIAL',
  CostCodeGrp: 'GLAZING', FinPeriod: '012027', Module: 'IN',
  Type: null, ReferenceNbr: null, Reference: 'IR003876', SupplierInvNbr: null,
  PreferredVendor: 'S0000117', PreferredVendorName: 'Concept Aluminium Coatings Pty Ltd',
  Employee: null, EmployeeName: null,
  InventoryItem: 'CON-SS10GM', InventoryItemDescr: '185mm Subsill',
  InventoryClass: 'GLAZING', Description: '181mm Subsill @ 6500',
  TranDate: '2026-07-17T00:00:00Z', Date: '2026-07-17T00:00:00Z',
  Qty: 15, Amount: 1584.32, UnitRate: 0, UOM: 'EACH',
};
/* LABOUR. Note the two dates DIFFER — worked the 15th, posted the 22nd. */
const LABOUR = {
  Project: '6163', TranID: 43264, CostCode: '2000102', AccountGroup: 'STAFF',
  CostCodeGrp: 'CLADDING', FinPeriod: '112026', Module: null,
  Type: null, ReferenceNbr: null, Reference: null, SupplierInvNbr: null,
  PreferredVendor: null, PreferredVendorName: null,
  Employee: 'EP00000031', EmployeeName: 'MATAAC Renante, Mr',
  InventoryItem: 'DR', InventoryItemDescr: 'Draftsman',
  InventoryClass: 'NONSTKDFT', Description: 'Cladding Shop Drawing',
  TranDate: '2026-05-22T00:00:00Z', Date: '2026-05-15T00:00:00Z',
  Qty: 6, Amount: 462, UnitRate: 77, UOM: 'HOUR',
};

/* ⚠ WITH THE TENANT'S CLASSIFICATION. Without it every line is is_cost=false and a spend breakdown
   sees nothing — which is the deliberate fail-closed, tested below. */
const COST_GROUPS = new Set(['SUBCONT', 'MATERIAL', 'STAFF', 'EQUIP', 'OTHER', 'CONSULT', 'LABOUR']);
const lines = toLedgerLines([BILL, RECEIPT, LABOUR], 'T', { costGroups: COST_GROUPS });
const line = (id) => lines.find((l) => l.tran_id === id);

test('every column these rows need is actually requested from the inquiry', () => {
  /* A $select missing one of these returns the column as undefined, which stores as null and looks
     exactly like "this kind of row does not have one". */
  for (const c of ['Module', 'Type', 'ReferenceNbr', 'Reference', 'SupplierInvNbr',
                   'PreferredVendor', 'PreferredVendorName', 'Employee', 'EmployeeName',
                   'InventoryItem', 'InventoryItemDescr', 'Description', 'TranDate', 'Date',
                   'UnitRate', 'UOM']) {
    assert.ok(ACTUALS_SELECT.includes(c), c);
  }
});

// ── ⚠ Module decides what a row even means ─────────────────────────────────
test('⚠ the source comes from Module, not from which fields happen to be filled', () => {
  assert.equal(sourceOf('AP'), 'bill');
  assert.equal(sourceOf('IN'), 'receipt');
  assert.equal(sourceOf(null), 'labour');
  assert.equal(sourceOf(''), 'labour');
  /* An unmapped module is NAMED rather than folded into one of the three — a new document type in
     MYOB must be visible, not silently labelled as labour. */
  assert.equal(sourceOf('SO'), 'other');
});
test('…so a bill whose supplier invoice number is blank is still a bill', () => {
  const [l] = toLedgerLines([{ ...BILL, TranID: 1, SupplierInvNbr: null }]);
  assert.equal(l.source, 'bill');
  assert.equal(l.supplier_inv_nbr, null);
  /* Inferring the source backwards from the fields would have made this a receipt. */
});

// ── the supplier bill: the whole point of the feature ───────────────────────
test('⚠ a subcontractor bill carries the supplier’s OWN invoice number', () => {
  const l = line(54002);
  assert.equal(l.source, 'bill');
  assert.equal(l.supplier_inv_nbr, 'INV-0359');
  assert.equal(l.doc_type, 'Bill');
  assert.equal(l.doc_ref, 'B00012906');
  assert.equal(l.amount, 3200);
  assert.equal(l.qty, 32);
  assert.equal(l.uom, 'HOUR');
});
test('⚠ the vendor name is stored as ITEM master data, never as supplier_name', () => {
  const l = line(54002);
  assert.equal(l.item_vendor, 'S0000419');
  assert.equal(l.item_vendor_name, 'ANCHORED CONSTRUCTIONS P / L.');
  /* The name would be a confident lie on a line bought from an alternative source, so nothing may
     call it the supplier. The bill reference and invoice number beside it are the hard evidence. */
  assert.equal('supplier_name' in l, false);
});

// ── the receipt: one step short of an invoice, and it must say so ───────────
test('⚠ an inventory receipt has NO supplier invoice — that is a fact, not a gap', () => {
  const l = line(50607);
  assert.equal(l.source, 'receipt');
  assert.equal(l.supplier_inv_nbr, null);
  assert.equal(l.doc_type, null);
  assert.equal(l.doc_ref, null);
  /* What it does have is the receipt number, which is NOT a supplier invoice and must not be shown
     as one. */
  assert.equal(l.reference, 'IR003876');
});

// ── labour ─────────────────────────────────────────────────────────────────
test('labour carries the person and the rate, and no supplier of any kind', () => {
  const l = line(43264);
  assert.equal(l.source, 'labour');
  assert.equal(l.employee_name, 'MATAAC Renante, Mr');
  assert.equal(l.item_desc, 'Draftsman');
  assert.equal(l.unit_rate, 77);
  assert.equal(l.qty, 6);
  assert.equal(l.item_vendor_name, null);
  assert.equal(l.supplier_inv_nbr, null);
});
test('⚠ both dates are kept — the work and the posting are not the same day', () => {
  const l = line(43264);
  assert.equal(l.doc_date, '2026-05-15', 'when it happened');
  assert.equal(l.tran_date, '2026-05-22', 'when it hit the ledger');
  /* A period comparison needs the posting date; a "what happened when" list wants the other. */
});
test('…and a date is stored as a day, not a timestamp', () => {
  assert.equal(line(54002).tran_date, '2026-08-10');
  const [odd] = toLedgerLines([{ ...BILL, TranID: 2, TranDate: 'not a date' }]);
  assert.equal(odd.tran_date, null);
});

// ── absence has to be distinguishable ──────────────────────────────────────
test('⚠ absent fields are NULL, not empty strings', () => {
  /* '' reads as "known to be empty"; these are "does not apply to this kind of row", which is a
     different fact and the entire reason `source` exists. */
  const l = line(43264);
  for (const f of ['doc_type', 'doc_ref', 'reference', 'supplier_inv_nbr', 'item_vendor', 'item_vendor_name']) {
    assert.equal(l[f], null, f);
  }
});

// ── the grain, and the refusal that protects it ────────────────────────────
test('one row per transaction, keyed on TranID', () => {
  assert.equal(lines.length, 3);
  assert.equal(new Set(lines.map((l) => l.tran_id)).size, 3);
  assert.ok(lines.every((l) => l.synced_at === 'T'));
});
test('⚠ REFUSES on a duplicate TranID — paging repeated a row, or the grain changed', () => {
  /* myob_actuals sums these same rows, so a duplicate would double-count there too. The ledger read
     depends on TranID being unique for its own paging; this is the check that it still is. */
  assert.throws(() => toLedgerLines([BILL, { ...BILL }]), (e) => {
    assert.ok(e instanceof LedgerGrainError);
    assert.match(e.message, /duplicate TranID/);
    assert.deepEqual(e.detail, [54002]);
    return true;
  });
});
test('a row with no project or no TranID is skipped, not written headless', () => {
  assert.deepEqual(toLedgerLines([{ ...BILL, Project: '  ' }]), []);
  assert.deepEqual(toLedgerLines([{ ...BILL, TranID: 0 }]), []);
});
test('Project is trimmed — the wire pads it on unfiltered reads', () => {
  const [l] = toLedgerLines([{ ...BILL, Project: '6163      ' }]);
  assert.equal(l.project_id, '6163');
});
test('an unparseable amount cannot poison the row', () => {
  const [l] = toLedgerLines([{ ...BILL, Amount: 'nope', Qty: undefined }]);
  assert.equal(l.amount, 0);
  assert.equal(l.qty, 0);
});
test('synced_at is omitted entirely when none is given', () => {
  const [l] = toLedgerLines([BILL]);
  assert.equal('synced_at' in l, false);
});

// ── ⚠ COST OR REVENUE — the verdict has to travel with the row ──────────────
/* The table stored account_group but not the tenant's verdict on it, so the vendor breakdown summed
 * every line. Alclad books revenue through account groups named after the PACKAGES (GLAZING,
 * CLADDING, RECLAD, FINS) as CREDITS — so on 6163 the panel showed supplier percentages adding to
 * 146% and a "not attributable" line of −86,131.14: cost netted against income.
 *
 * Which is the same failure this feed hit on its first dry run, when one project reported
 * 10,734,945.75. myob_actuals has classified from the tenant ever since; the detail table simply
 * never carried the answer forward.
 */
test('⚠ cost lines are flagged from the tenant classification', () => {
  assert.ok(lines.every((l) => l.is_cost), 'SUBCONT, MATERIAL and STAFF are all expense groups');
});

test('⚠ a REVENUE line is flagged false — its group is named after the package', () => {
  const income = { ...BILL, TranID: 99, AccountGroup: 'CLADDING', Amount: -86131.14 };
  const [l] = toLedgerLines([income], null, { costGroups: COST_GROUPS });
  assert.equal(l.is_cost, false);
  /* ⚠ AND NOT BECAUSE IT IS NEGATIVE. The verdict is the account group's Type in MYOB; a credit can
     be a reversal, which is a negative COST and must stay in the spend. */
  const reversal = { ...BILL, TranID: 98, Amount: -250 };
  const [rev] = toLedgerLines([reversal], null, { costGroups: COST_GROUPS });
  assert.equal(rev.is_cost, true, 'a negative amount on an expense group is still cost');
});

test('⚠ with NO classification nothing is claimed — is_cost stays false', () => {
  /* Fail closed. A consumer filtering on the flag then sees nothing, which is visibly wrong, rather
     than seeing everything, which looks right and is not. */
  const [l] = toLedgerLines([BILL]);
  assert.equal(l.is_cost, false);
});
