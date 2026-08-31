// Opportunity-summary query building. Run with: npm test
//
// This route exists so the budget's discrepancy card works for app users who have NO
// Salesforce connection — it can answer from a service account. That makes its input
// validation load-bearing in a way the per-user proxy's is not: a caller with no Salesforce
// rights at all reaches it, and the GP / number field names it interpolates into SOQL come
// straight from the client's Settings mapping.
import assert from "node:assert/strict";
import test from "node:test";
import { buildSummaryQuery, shapeSummary, pickField, validField, SF_ID } from "./oppSummary.js";

const ID = "0065j00000AbCdEfGh";   // 18-char Salesforce id

test("builds the query for a plain opportunity", () => {
  const q = buildSummaryQuery(ID, "", "");
  assert.equal(q.soql, `SELECT Id, Name, Amount FROM Opportunity WHERE Id = '${ID}'`);
  assert.deepEqual(q.extra, []);
});

test("includes the mapped GP and number fields", () => {
  const q = buildSummaryQuery(ID, "Budgeted_GP__c", "Opportunity_Number__c");
  assert.match(q.soql, /Budgeted_GP__c/);
  assert.match(q.soql, /Opportunity_Number__c/);
  assert.deepEqual(q.extra, ["Budgeted_GP__c", "Opportunity_Number__c"]);
});

test("allows a dotted relationship field", () => {
  assert.ok(validField("Account.Name"));
  assert.match(buildSummaryQuery(ID, "Account.Name", "").soql, /Account\.Name/);
});

test("never duplicates a column the base query already has", () => {
  const q = buildSummaryQuery(ID, "Amount", "");
  assert.equal(q.cols.filter((c) => c === "Amount").length, 1);
});

// ── the injection guard ─────────────────────────────────────────────────────
// Each of these, unvalidated, would break out of the column list and change what the
// query returns — run as the SERVICE ACCOUNT, for a caller with no Salesforce rights.
test("field names that try to break out of the column list are dropped", () => {
  const nasty = [
    "Name FROM Opportunity WHERE Id!='' AND Name LIKE '%",   // widen to every opportunity
    "Id) FROM Account--",                                     // close the projection, comment out
    "Amount, (SELECT Id FROM Notes)",                         // smuggle a subquery
    "Name'",                                                  // escape the quoted id
    "Name;DELETE",
    "*",
    "Name Amount",                                            // bare space
    " Budgeted_GP__c",                                        // leading space
    "1Field",                                                 // must start with a letter
    "Account..Name",                                          // empty path segment
  ];
  for (const f of nasty) {
    assert.equal(validField(f), false, `should reject: ${f}`);
    const q = buildSummaryQuery(ID, f, "");
    assert.equal(q.soql, `SELECT Id, Name, Amount FROM Opportunity WHERE Id = '${ID}'`, `leaked into SOQL: ${f}`);
    assert.equal(pickField({ Name: "x" }, f), undefined, `read a rejected field: ${f}`);
  }
});

test("a bad opportunity id is refused outright, not queried", () => {
  for (const bad of ["", "   ", "short", "0065j00000AbCdEfGhIJK", "0065'--", "0065 00000AbCdEf", null, undefined]) {
    assert.equal(buildSummaryQuery(bad, "", ""), null, `should refuse id: ${JSON.stringify(bad)}`);
  }
  assert.ok(SF_ID.test("0065j00000AbCdE"));       // 15-char form is valid too
});

// ── the response shape ──────────────────────────────────────────────────────
test("shapes a full record", () => {
  const rec = { Id: ID, Name: "6931 KM William Angliss", Amount: 1240000, Budgeted_GP__c: 18.5, Opportunity_Number__c: "OPP-01234" };
  const out = shapeSummary(rec, { id: ID, gpField: "Budgeted_GP__c", numberField: "Opportunity_Number__c", viaService: true });
  assert.deepEqual(out, { id: ID, name: "6931 KM William Angliss", number: "OPP-01234", amount: 1240000, bgp: 18.5, viaService: true });
});

test("a missing value is null, never a guess", () => {
  // the card treats a missing Salesforce figure as zero and shows the whole budget as the
  // discrepancy — that is deliberate, so these must not arrive as 0 or ""
  const out = shapeSummary({ Id: ID, Name: "X", Amount: null }, { id: ID, gpField: "Budgeted_GP__c", numberField: "", viaService: false });
  assert.equal(out.amount, null);
  assert.equal(out.bgp, null);
  assert.equal(out.number, "");
  assert.equal(out.viaService, false);
});

test("an unmapped GP field yields null rather than reading something else", () => {
  const rec = { Id: ID, Name: "X", Amount: 1, Budgeted_GP__c: 18.5 };
  assert.equal(shapeSummary(rec, { id: ID, gpField: "", numberField: "" }).bgp, null);
});

test("a dotted number field is read through the relationship", () => {
  const rec = { Id: ID, Name: "X", Amount: 1, Account: { Name: "Builder Co" } };
  assert.equal(shapeSummary(rec, { id: ID, gpField: "", numberField: "Account.Name" }).number, "Builder Co");
});

test("falls back to the requested id when the record has none", () => {
  assert.equal(shapeSummary({ Name: "X" }, { id: ID, gpField: "", numberField: "" }).id, ID);
});
