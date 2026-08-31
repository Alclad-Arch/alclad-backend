// Pure helpers for /api/salesforce/opportunity-summary — kept out of server.js so the
// query building and the field validation can be tested without booting the server.
//
// The GP and opportunity-number fields are MAPPED BY THE CLIENT (Settings → Salesforce),
// so they arrive as request parameters and are interpolated straight into SOQL. Validating
// them as bare API names is the whole defence against SOQL injection here — without it,
// `gpField=Name FROM Opportunity WHERE Id!='' AND Name LIKE '%` walks the whole object.

// 15- or 18-character Salesforce record id.
export const SF_ID = /^[A-Za-z0-9]{15,18}$/;
// A field API name, optionally dotted for a relationship (Account.Name). Nothing else:
// no spaces, quotes, commas, parentheses or operators.
export const SF_API_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

export const validField = (f) => !!f && SF_API_NAME.test(f);

// The query for one opportunity, plus the bare fallback used when a mapped column turns
// out to be unreadable — one field the identity can't see fails the WHOLE SOQL, and losing
// the GP column beats losing the card.
export function buildSummaryQuery(id, gpField, numberField) {
  if (!SF_ID.test(String(id || "").trim())) return null;
  const oid = String(id).trim();
  const extra = [gpField, numberField].filter(validField);
  const cols = [...new Set(["Id", "Name", "Amount", ...extra])];
  return {
    cols,
    extra,
    soql: `SELECT ${cols.join(", ")} FROM Opportunity WHERE Id = '${oid}'`,
    minimalSoql: `SELECT Id, Name, Amount FROM Opportunity WHERE Id = '${oid}'`,
  };
}

// Read a possibly-dotted field off a Salesforce record, without letting an unvalidated
// name reach the record at all.
export function pickField(rec, f) {
  if (!validField(f) || !rec) return undefined;
  return f.split(".").reduce((o, k) => (o == null ? undefined : o[k]), rec);
}

// The response body the budget card consumes. A missing value is null, never a guess:
// the card treats a missing Salesforce figure as zero and shows the whole budget as the
// discrepancy, which is the intended loud behaviour.
export function shapeSummary(rec, { id, gpField, numberField, viaService }) {
  const bgp = pickField(rec, gpField);
  return {
    id: (rec && rec.Id) || id,
    name: (rec && rec.Name) || "",
    number: numberField ? String(pickField(rec, numberField) ?? "") : "",
    amount: rec && rec.Amount != null ? Number(rec.Amount) : null,
    bgp: bgp === undefined || bgp === null || bgp === "" ? null : Number(bgp),
    viaService: !!viaService,
  };
}
