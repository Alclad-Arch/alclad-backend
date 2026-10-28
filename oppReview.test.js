// Reva's Salesforce feed — query building. Run with: npm test
//
// The feed is answered by the SERVICE ACCOUNT, which sees the whole org, so what reaches SOQL
// matters: only validated Salesforce ids, only fixed field lists.
import assert from "node:assert/strict";
import test from "node:test";
import { cleanIds, buildReviewQueries, buildPriorQueries, shapeRecord, MAX_OPPS, TEXT_MAX } from "./oppReview.js";

const A = "0065g00000AbCdEAAZ", B = "0065g00000XyZwvAAA";

test("only real Salesforce ids get through — anything else is dropped, never quoted", () => {
  assert.deepEqual(cleanIds([A, ` ${B} `, "x' OR Id != '", "", null, "0065g0000", A]), [A, B]);
});

test("capped, so a job can't fan out into dozens of deals", () => {
  const many = Array.from({ length: 20 }, (_, i) => "0065g00000AbCd" + String(i).padStart(4, "0"));
  assert.equal(cleanIds(many).length, MAX_OPPS);
});

test("no ids, no query", () => {
  assert.equal(buildReviewQueries([]), null);
  assert.equal(buildReviewQueries(["not an id"]), null);
  assert.equal(buildPriorQueries([], []), null);
});

test("the three reads are on exactly the budget's opportunities", () => {
  const q = buildReviewQueries([A, B]);
  assert.deepEqual(q.ids, [A, B]);
  for (const s of [...q.opportunity, ...q.tasks, ...q.emails]) assert.match(s, new RegExp(`IN \\('${A}', '${B}'\\)`));
  assert.match(q.opportunity[0], /^SELECT .*Description_Rich__c.* FROM Opportunity WHERE Id IN/);
  assert.match(q.tasks[0], /FROM Task WHERE WhatId IN .* ORDER BY CreatedDate DESC LIMIT \d+$/);
  assert.match(q.emails[0], /FROM EmailMessage WHERE RelatedToId IN/);
});

test("richest field set first, then plainer ones — one unreadable custom field must not cost the whole read", () => {
  const q = buildReviewQueries([A]);
  assert.ok(q.opportunity.length >= 2 && q.opportunity.at(-1).includes("Id, Name"));
  assert.ok(!q.opportunity.at(-1).includes("__c"), "the last opportunity set has no custom fields");
});

test("prior opportunities: same account, excluding this job's own", () => {
  const p = buildPriorQueries(["0015g00000AcCoUAAA"], [A]);
  assert.match(p[0], /WHERE AccountId IN \('0015g00000AcCoUAAA'\) AND Id NOT IN \('0065g00000AbCdEAAZ'\) ORDER BY CloseDate DESC/);
  assert.ok(!/NOT IN/.test(buildPriorQueries(["0015g00000AcCoUAAA"], [])[0]));
});

test("records come back as plain JSON: no attributes, relations flattened, HTML stripped, long text trimmed", () => {
  const r = shapeRecord({
    attributes: { type: "Opportunity" }, Id: A, Account: { attributes: {}, Name: "Hansen Yuncken" }, Owner: null,
    Description_Rich__c: "<p>Supply &amp; install</p><p>Excl. spotting</p>", TextBody: "x".repeat(TEXT_MAX + 50), Amount: 125000,
  });
  assert.equal(r.attributes, undefined);
  assert.equal(r.Account, "Hansen Yuncken");
  assert.equal(r.Owner, null);
  assert.equal(r.Description_Rich__c.trim(), "Supply & install\nExcl. spotting");
  assert.ok(r.TextBody.endsWith("…(trimmed)") && r.TextBody.length < TEXT_MAX + 20);
  assert.equal(r.Amount, 125000);
});
