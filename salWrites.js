// Sal, Alclad's sales assistant (2026-10-29): the ONLY Salesforce writes he can make, and how they are
// sent. Jed chose "an in-app chat that reads and writes Salesforce through the PERSON's own
// connection, so history shows their name". Sal proposes a change set in plain English, the person
// says yes in alclad.app, and the change set comes here: checked against this list, then sent as ONE
// Salesforce composite request with allOrNone, so it all happens or none of it does (his skill:
// "write it all, never partially").
//
// What he may do — nothing else gets through:
//   create_contact       a contact on an Account (only when the person said to)
//   create_task          a call log or a follow-up; OwnerId is always the person, never chosen
//   update_task          complete it, move its date, add notes
//   update_opportunity   NextStep; Project_Rating__c / StageName only when the person said so
// Deleting anything, other objects, other fields, other owners: refused.

export const SAL_MAX_CHANGES = 12;
export const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TASK_SUBJECTS = ["Task", "Call - Outbound", "Call - Inbound", "Call - LAM", "Call - Other", "Meeting - F2F", "Meeting - Online"];
export const RATINGS = ["Too Early to Rate", "RED", "YELLOW", "GREEN", "WON", "LOST", "CLOSED"];
export const STAGES = ["Qualifying", "Tender Quoted", "Quote Awarded", "Negotiation", "Closed Won", "Closed Lost", "Closed Not Quoted"];
const NEW_CONTACT = "$new_contact";

// field → check; a check returns the value to send, or throws a reason
const text = (max) => (v) => { const s = String(v == null ? "" : v); if (s.length > max) throw `is longer than ${max} characters`; return s; };
const req = (f) => (v) => { if (v == null || String(v).trim() === "") throw "is required"; return f(v); };
const oneOf = (list) => (v) => { if (!list.includes(v)) throw `must be one of ${list.join(", ")}`; return v; };
const id = (v) => { if (!SF_ID.test(String(v || ""))) throw "is not a Salesforce id"; return String(v); };
const date = (v) => { if (!DATE.test(String(v || ""))) throw "must be a date like 2026-11-02"; return String(v); };
const whoId = (v) => (v === NEW_CONTACT ? v : id(v));

const RULES = {
  create_contact: {
    FirstName: text(40), LastName: req(text(80)), AccountId: req(id), Email: text(80), Phone: text(40), Title: text(128),
  },
  create_task: {
    Subject: req(oneOf(TASK_SUBJECTS)), ActivityDate: req(date), Status: req(oneOf(["Open", "Completed"])),
    Priority: oneOf(["Normal", "High"]), Description: text(32000), WhatId: req(id), WhoId: whoId,
    CallType: oneOf(["Inbound", "Outbound", "Internal"]), TaskSubtype: oneOf(["Task", "Email", "Call"]),
  },
  update_task: {
    Subject: oneOf(TASK_SUBJECTS), ActivityDate: date, Status: oneOf(["Open", "Completed"]), Priority: oneOf(["Normal", "High"]), Description: text(32000),
  },
  update_opportunity: {
    NextStep: text(255), Project_Rating__c: oneOf(RATINGS), StageName: oneOf(STAGES),
  },
};
const OBJECT = { create_contact: "Contact", create_task: "Task", update_task: "Task", update_opportunity: "Opportunity" };

/* Check a change set. Returns { changes } — each { op, id?, fields } with only allowed, checked
   fields — or { error } naming the first thing wrong. Nothing is ever sent from a set with an error. */
export function checkChanges(input) {
  const list = Array.isArray(input) ? input : null;
  if (!list || !list.length) return { error: "No changes to make" };
  if (list.length > SAL_MAX_CHANGES) return { error: `At most ${SAL_MAX_CHANGES} changes at once` };
  const out = [];
  let contacts = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i] || {};
    const at = `change ${i + 1}`;
    const rules = RULES[c.op];
    if (!rules) return { error: `${at}: "${c.op}" isn't something Sal can do` };
    const fields = c.fields && typeof c.fields === "object" && !Array.isArray(c.fields) ? c.fields : {};
    const clean = {};
    for (const k of Object.keys(fields)) {
      if (!(k in rules)) return { error: `${at}: ${OBJECT[c.op]}.${k} can't be set by Sal` };
      if (fields[k] === undefined || fields[k] === null || fields[k] === "") continue;
      try { clean[k] = rules[k](fields[k]); } catch (why) { return { error: `${at}: ${k} ${why}` }; }
    }
    for (const k of Object.keys(rules)) {
      if (clean[k] !== undefined) continue;
      try { rules[k](undefined); } catch (why) { if (why === "is required") return { error: `${at}: ${k} is required` }; }
    }
    if (c.op.startsWith("update_")) {
      if (!SF_ID.test(String(c.id || ""))) return { error: `${at}: which ${OBJECT[c.op]}? (no id)` };
      if (!Object.keys(clean).length) return { error: `${at}: nothing to change` };
    }
    if (c.op === "create_contact" && ++contacts > 1) return { error: "Only one new contact at a time" };
    if (clean.WhoId === NEW_CONTACT && !list.slice(0, i).some((x) => x && x.op === "create_contact"))
      return { error: `${at}: uses the new contact before it is created` };
    out.push({ op: c.op, ...(c.op.startsWith("update_") ? { id: String(c.id) } : {}), fields: clean });
  }
  return { changes: out };
}

/* The checked set as ONE composite request (allOrNone): created tasks are owned by the person
   (ownerId, their Salesforce user id), and "$new_contact" points at the contact created earlier in
   the same request. */
export function compositeRequest(changes, ownerId, version = "v60.0") {
  const base = `/services/data/${version}/sobjects`;
  return {
    allOrNone: true,
    compositeRequest: changes.map((c, i) => {
      const ref = c.op === "create_contact" ? "new_contact" : `c${i}`;
      const body = { ...c.fields };
      if (body.WhoId === NEW_CONTACT) body.WhoId = "@{new_contact.id}";
      if (c.op === "create_task") body.OwnerId = ownerId;
      return c.op.startsWith("create_")
        ? { method: "POST", url: `${base}/${OBJECT[c.op]}`, referenceId: ref, body }
        : { method: "PATCH", url: `${base}/${OBJECT[c.op]}/${c.id}`, referenceId: ref, body };
    }),
  };
}

/* Salesforce's composite answer, as one line per change: { op, ok, id?, error? }. With allOrNone a
   failure rolls everything back, so every change is reported as not made, with the reason that
   caused it on the change that failed. */
export function readComposite(changes, answer) {
  const parts = (answer && Array.isArray(answer.compositeResponse)) ? answer.compositeResponse : [];
  const failed = parts.some((p) => !(p.httpStatusCode >= 200 && p.httpStatusCode < 300));
  return changes.map((c, i) => {
    const p = parts[i] || {};
    const ok = !failed && p.httpStatusCode >= 200 && p.httpStatusCode < 300;
    const err = Array.isArray(p.body) && p.body[0] && p.body[0].message;
    const rolled = Array.isArray(p.body) && p.body[0] && p.body[0].errorCode === "PROCESSING_HALTED";
    return { op: c.op, ok, ...(ok && p.body && p.body.id ? { id: p.body.id } : {}), ...(c.id ? { id: c.id } : {}),
      ...(!ok ? { error: rolled || !err ? "not made — the change set was rolled back" : err } : {}) };
  });
}
