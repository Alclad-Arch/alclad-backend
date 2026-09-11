// Pure helpers for /api/salesforce/opportunity-search — the type-ahead behind the
// "New estimating project" opportunity picker.
//
// ── WHY THIS IS ITS OWN ENDPOINT AND NOT THE GENERIC PROXY ──
// The picker used to build SOQL in the browser and send it through /api/salesforce/*splat,
// which is a raw passthrough running as THE CALLER. That is fine while every searcher has
// their own Salesforce grant. It stops being fine the moment the service account backs the
// search: the generic proxy would then let any session run arbitrary SOQL as the service
// identity, which sees the whole org. So the term comes over the wire and the QUERY IS BUILT
// HERE — a caller chooses what to search for, never what to select or from where.
//
// Same defence as oppSummary.js for the mapped number field: validated as a bare API name.

import { SF_API_NAME, validField } from "./oppSummary.js";

export { SF_API_NAME, validField };

/* A SOQL string-literal escape. Backslash FIRST — escaping it after the quote would double
   the backslashes this function had just added — then the quote, so O'Brien does not end the
   literal early.
 *
 * % and _ are escaped too, which the browser version did NOT do. They are LIKE wildcards, so
 * a term containing one quietly searched for something other than what was typed: "50%
 * deposit" matched every opportunity beginning "50". Escaping them makes the search mean
 * what the person typed.
 */
export const escapeSoql = (s) => String(s)
  .replace(/\\/g, "\\\\")
  .replace(/'/g, "\\'")
  .replace(/%/g, "\\%")
  .replace(/_/g, "\\_");

export const MIN_TERM = 2;
export const MAX_TERM = 80;      // a search box, not a document
export const LIMIT = 20;

/* The progressive fallback the picker already relied on, moved server-side.
 *
 * ONE UNREADABLE FIELD FAILS THE WHOLE SOQL — Salesforce rejects the query rather than
 * omitting the column — so a profile that cannot see the mapped opportunity-number field
 * would get no results at all rather than results without that column. Each set drops the
 * most fragile part: the mapped field, then the relationship fields, then everything but
 * Id and Name. A plainer row beats an empty list.
 */
export function buildSearchQuery(term, numberField) {
  const t = String(term == null ? "" : term).trim();
  if (t.length < MIN_TERM || t.length > MAX_TERM) return null;
  const esc = escapeSoql(t);
  const num = validField(numberField) ? numberField : "";
  const sets = [
    `Id, Name, StageName, CloseDate, Account.Name, Owner.Name${num ? ", " + num : ""}`,
    "Id, Name, StageName, CloseDate, Account.Name, Owner.Name",
    "Id, Name",
  ];
  /* Deduped: with no mapped number field the first two sets are identical, and running the
     same failing query twice is a wasted Salesforce round trip on every keystroke. */
  const uniq = [...new Set(sets)];
  return {
    term: t,
    soqls: uniq.map((cols) =>
      `SELECT ${cols} FROM Opportunity WHERE Name LIKE '%${esc}%' ORDER BY Name LIMIT ${LIMIT}`),
  };
}
