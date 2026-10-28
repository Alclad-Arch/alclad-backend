// Pure helpers for /api/salesforce/opportunity-review — Reva AI's read of Salesforce.
//
// Jed 2026-10-28: Reva (the budget-review agent) checks a budget against its Salesforce
// opportunities, the tasks/emails on them (where the builder's scope requests, addenda and agreed
// prices live) and the builder's prior opportunities. Her login has no personal Salesforce grant,
// and the generic proxy is per-user only — so this is a NARROW, READ-ONLY feed on the service
// account, chosen over a Salesforce licence for her.
//
// What keeps it narrow (the service identity sees the whole org):
//   1. The caller names a BUDGET, never an opportunity. The opportunities are the ones that budget's
//      job is linked to on the Projects hub — looked up server-side — so it cannot be pointed at an
//      arbitrary deal.
//   2. Every query is built HERE. Ids are validated as Salesforce ids before they go anywhere near
//      SOQL; the only other input is fixed lists of field names.
//   3. Only the review roles may call it (REVIEW_ROLES in server.js).

import { SF_ID } from "./oppSummary.js";

export const MAX_OPPS = 6;          // a job has a glazing and a cladding opportunity, rarely more
export const TASK_LIMIT = 60;
export const EMAIL_LIMIT = 40;
export const PRIOR_LIMIT = 20;
export const TEXT_MAX = 4000;       // per long-text field: an email body, a rich description

/* Field sets, richest first. ONE UNREADABLE FIELD FAILS THE WHOLE SOQL, so each later set drops
   the custom fields — a plainer answer beats none. */
export const OPP_SETS = [
  "Id, Name, AccountId, Account.Name, Owner.Name, StageName, Amount, CloseDate, Budgeted_GP__c, Forecast_Start_Date__c, Forecast_End_Date__c, Opportunity_Classification__c, Extra_Features__c, Notes__c, Description_Rich__c, Hit_List_Notes__c, Opportunity_Number__c",
  "Id, Name, AccountId, Account.Name, Owner.Name, StageName, Amount, CloseDate, Description",
  "Id, Name, AccountId, StageName, Amount, CloseDate",
];
export const TASK_SETS = [
  "Id, WhatId, Subject, Description, ActivityDate, Status, TaskSubtype, Who.Name, Owner.Name, CreatedDate",
  "Id, WhatId, Subject, Description, ActivityDate, Status, CreatedDate",
];
export const EMAIL_SETS = [
  "Id, RelatedToId, Subject, FromAddress, ToAddress, MessageDate, TextBody",
];
export const PRIOR_SETS = [
  "Id, Name, StageName, Amount, CloseDate, Budgeted_GP__c, Opportunity_Number__c, Owner.Name",
  "Id, Name, StageName, Amount, CloseDate",
];

/* The opportunity ids a budget's job is linked to, cleaned: valid Salesforce ids only, no
   duplicates, capped. Anything else is dropped rather than quoted into SOQL. */
export function cleanIds(ids) {
  const out = [];
  for (const raw of ids || []) {
    const id = String(raw == null ? "" : raw).trim();
    if (SF_ID.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_OPPS) break;
  }
  return out;
}

const inList = (ids) => ids.map((id) => `'${id}'`).join(", ");

/* WHICH OPPORTUNITIES A BUDGET ANSWERS TO — the same three places the app reads, in its order
   (Jed 2026-10-29: Reva said "not linked to a job on the Projects hub" for a budget Bridget had built
   from a hub-linked takeoff; the feed only followed the budget's OWN hub link):
     1. the hub job's packages (pm_package_opportunities) — the hub job being the budget's own
        pm_project_id, else the hub job whose links.budget names it, else its takeoff's hub job;
     2. the opportunity stamped on the budget (cb_projects.extra.sfOpp — the Estimating hub's New
        Project stamps it);
     3. the opportunity on its takeoff (est_pto_projects.data.sfOpp, via extra.dtProjectId).
   Duplicates are dropped (first place wins), every id is validated before it is used, and `reason`
   says plainly why there is nothing when there is nothing. Still only ever this budget's deals. */
export function budgetOpportunities({ hubPackages = [], budgetOpp = null, takeoffOpp = null, hubId = null } = {}) {
  const out = [];
  const add = (scope, o, source) => {
    const id = String((o && (o.id || o.sf_opportunity_id)) || "").trim();
    if (!SF_ID.test(id) || out.some((x) => x.id === id) || out.length >= MAX_OPPS) return;
    out.push({ scope: scope || "", id, number: (o.number || o.sf_opportunity_number || "") || "", name: (o.name || o.sf_opportunity_name || "") || "", source });
  };
  for (const p of hubPackages || []) add(p && p.scope, p, "hub");
  if (budgetOpp) add("", budgetOpp, "budget");
  if (takeoffOpp) add("", takeoffOpp, "takeoff");
  if (out.length) return { packages: out };
  return { packages: [], reason: hubId
    ? "No Salesforce opportunity is linked to this budget: its hub job's packages have none, and neither the budget nor its takeoff is stamped with one."
    : "No Salesforce opportunity is linked to this budget: it isn't linked to a job on the Projects hub (directly or through its takeoff), and neither the budget nor its takeoff is stamped with one." };
}

/* The four reads, each a list of SOQL strings to try in order. `accountIds` come back from the
   first read (Salesforce's own answer, validated again here). */
export function buildReviewQueries(oppIds) {
  const ids = cleanIds(oppIds);
  if (!ids.length) return null;
  const q = inList(ids);
  return {
    ids,
    opportunity: OPP_SETS.map((c) => `SELECT ${c} FROM Opportunity WHERE Id IN (${q})`),
    tasks: TASK_SETS.map((c) => `SELECT ${c} FROM Task WHERE WhatId IN (${q}) ORDER BY CreatedDate DESC LIMIT ${TASK_LIMIT}`),
    emails: EMAIL_SETS.map((c) => `SELECT ${c} FROM EmailMessage WHERE RelatedToId IN (${q}) ORDER BY MessageDate DESC LIMIT ${EMAIL_LIMIT}`),
  };
}
export function buildPriorQueries(accountIds, excludeIds) {
  const acc = cleanIds(accountIds);
  if (!acc.length) return null;
  const not = cleanIds(excludeIds);
  return PRIOR_SETS.map((c) => `SELECT ${c} FROM Opportunity WHERE AccountId IN (${inList(acc)})` +
    (not.length ? ` AND Id NOT IN (${inList(not)})` : "") + ` ORDER BY CloseDate DESC LIMIT ${PRIOR_LIMIT}`);
}

/* A record as plain JSON for the agent: Salesforce's `attributes` dropped, relationship objects
   flattened to their Name (Account.Name → "Account": "…"), long text trimmed and HTML stripped. */
export function shapeRecord(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === "attributes") continue;
    if (v && typeof v === "object") { out[k] = v.Name == null ? null : String(v.Name); continue; }
    if (typeof v === "string") {
      const plain = /<[a-z][\s\S]*>/i.test(v) ? v.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&") : v;
      out[k] = plain.length > TEXT_MAX ? plain.slice(0, TEXT_MAX) + " …(trimmed)" : plain;
      continue;
    }
    out[k] = v;
  }
  return out;
}
