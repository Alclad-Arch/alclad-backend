// Sal's Salesforce writes — salWrites.js.
import assert from "node:assert/strict";
import test from "node:test";
import { checkChanges, compositeRequest, readComposite, SAL_MAX_CHANGES } from "./salWrites.js";

const OPP = "006Ab00000ABCDEFGH", TASK = "00TAb00000ABCDEFGH", ACC = "001Ab00000ABCDEFGH", CON = "003Ab00000ABCDEFGH", ME = "005Ab00000ABCDEFGH";
const callLog = { op: "create_task", fields: { Subject: "Call - Outbound", ActivityDate: "2026-10-29", Status: "Completed", CallType: "Outbound", TaskSubtype: "Call", WhatId: OPP, WhoId: CON, Description: "Purpose: …\nLogged via Sal" } };

test("a call log, a follow-up and NextStep pass, keeping only the fields given", () => {
  const r = checkChanges([callLog, { op: "create_task", fields: { Subject: "Task", ActivityDate: "2026-11-02", Status: "Open", Priority: "High", WhatId: OPP, WhoId: CON } },
    { op: "update_opportunity", id: OPP, fields: { NextStep: "Confirm fin package to Peter" } }]);
  assert.ok(r.changes, r.error);
  assert.equal(r.changes.length, 3);
  assert.deepEqual(Object.keys(r.changes[2].fields), ["NextStep"]);
});

test("⚠ nothing outside the list gets through", () => {
  assert.match(checkChanges([{ op: "delete_task", id: TASK }]).error, /isn't something Sal can do/);
  assert.match(checkChanges([{ op: "update_opportunity", id: OPP, fields: { Amount: 1 } }]).error, /Opportunity\.Amount can't be set/);
  assert.match(checkChanges([{ op: "create_task", fields: { ...callLog.fields, OwnerId: ME } }]).error, /Task\.OwnerId can't be set/);
  assert.match(checkChanges([{ op: "update_opportunity", id: OPP, fields: { Project_Rating__c: "PURPLE" } }]).error, /must be one of/);
  assert.match(checkChanges([{ op: "create_task", fields: { ...callLog.fields, Subject: "Lunch" } }]).error, /Subject must be one of/);
  assert.match(checkChanges([{ op: "create_task", fields: { ...callLog.fields, ActivityDate: "next Tuesday" } }]).error, /must be a date/);
  assert.match(checkChanges([{ op: "update_task", id: "bad", fields: { Status: "Completed" } }]).error, /no id/);
  assert.match(checkChanges([{ op: "update_task", id: TASK, fields: {} }]).error, /nothing to change/);
  assert.match(checkChanges([{ op: "create_task", fields: { Subject: "Task", Status: "Open", WhatId: OPP } }]).error, /ActivityDate is required/);
  assert.match(checkChanges([]).error, /No changes/);
  assert.match(checkChanges(Array(SAL_MAX_CHANGES + 1).fill(callLog)).error, /At most/);
  assert.match(checkChanges([{ op: "update_opportunity", id: OPP, fields: { NextStep: "x".repeat(256) } }]).error, /longer than 255/);
});

test("a new contact can be used by the tasks after it — never before, never two", () => {
  const con = { op: "create_contact", fields: { FirstName: "Peter", LastName: "Smith", AccountId: ACC } };
  const ok = checkChanges([con, { ...callLog, fields: { ...callLog.fields, WhoId: "$new_contact" } }]);
  assert.ok(ok.changes, ok.error);
  assert.match(checkChanges([{ ...callLog, fields: { ...callLog.fields, WhoId: "$new_contact" } }, con]).error, /before it is created/);
  assert.match(checkChanges([con, con]).error, /one new contact/);
});

test("ONE all-or-nothing request: tasks owned by the person, the new contact referenced", () => {
  const { changes } = checkChanges([{ op: "create_contact", fields: { LastName: "Smith", AccountId: ACC } },
    { ...callLog, fields: { ...callLog.fields, WhoId: "$new_contact" } }, { op: "update_task", id: TASK, fields: { Status: "Completed" } }]);
  const c = compositeRequest(changes, ME);
  assert.equal(c.allOrNone, true);
  assert.deepEqual(c.compositeRequest.map((r) => [r.method, r.url]), [
    ["POST", "/services/data/v60.0/sobjects/Contact"], ["POST", "/services/data/v60.0/sobjects/Task"], ["PATCH", `/services/data/v60.0/sobjects/Task/${TASK}`]]);
  assert.equal(c.compositeRequest[1].body.OwnerId, ME);
  assert.equal(c.compositeRequest[1].body.WhoId, "@{new_contact.id}");
  assert.equal(c.compositeRequest[0].referenceId, "new_contact");
  assert.equal(c.compositeRequest[2].body.OwnerId, undefined);   // an update never changes the owner
});

test("Salesforce's answer: all made, or none — the failing change says why", () => {
  const { changes } = checkChanges([callLog, { op: "update_opportunity", id: OPP, fields: { NextStep: "x" } }]);
  const good = readComposite(changes, { compositeResponse: [{ httpStatusCode: 201, body: { id: TASK } }, { httpStatusCode: 204, body: null }] });
  assert.deepEqual(good.map((r) => r.ok), [true, true]);
  assert.equal(good[0].id, TASK);
  const bad = readComposite(changes, { compositeResponse: [
    { httpStatusCode: 400, body: [{ errorCode: "PROCESSING_HALTED", message: "halted" }] },
    { httpStatusCode: 400, body: [{ errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "Next step needs a date" }] }] });
  assert.deepEqual(bad.map((r) => r.ok), [false, false]);
  assert.match(bad[0].error, /rolled back/);
  assert.equal(bad[1].error, "Next step needs a date");
});
