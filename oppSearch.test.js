// Opportunity-search query building. Run with: npm test
//
// This one matters more than its size suggests. The search is reachable by any role in
// SF_ALLOWED_ROLES and can be answered by the SERVICE ACCOUNT, which sees the whole org —
// so the search term and the mapped number field are attacker-controlled input that ends up
// inside SOQL. The browser used to build this query itself; moving it here is only an
// improvement if the escaping is actually right.
import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchQuery, escapeSoql, MIN_TERM, MAX_TERM, LIMIT } from "./oppSearch.js";

const only = (t, f) => buildSearchQuery(t, f).soqls[0];

// ── the term ────────────────────────────────────────────────────────────────
test("builds a LIKE search over Name", () => {
  const q = buildSearchQuery("tetris", "");
  assert.equal(q.term, "tetris");
  assert.match(q.soqls[0], /FROM Opportunity WHERE Name LIKE '%tetris%'/);
  assert.match(q.soqls[0], new RegExp(`ORDER BY Name LIMIT ${LIMIT}$`));
});

test("trims, and reports the trimmed term", () => {
  assert.equal(buildSearchQuery("  tetris  ", "").term, "tetris");
});

test("too short is null, not an empty query", () => {
  // The picker fires on every keystroke, so this is the NORMAL case, not an error one.
  assert.equal(buildSearchQuery("a", ""), null);
  assert.equal(buildSearchQuery("", ""), null);
  assert.equal(buildSearchQuery(null, ""), null);
  assert.equal(buildSearchQuery(undefined, ""), null);
  assert.equal(buildSearchQuery("   ", ""), null);
  assert.ok(buildSearchQuery("a".repeat(MIN_TERM), ""));
});

test("absurdly long is refused — a search box, not a document", () => {
  assert.ok(buildSearchQuery("a".repeat(MAX_TERM), ""));
  assert.equal(buildSearchQuery("a".repeat(MAX_TERM + 1), ""), null);
});

// ── escaping, which is the whole defence ────────────────────────────────────
test("a quote cannot end the literal early", () => {
  // O'Brien is the benign case; the same escape is what stops the malicious one.
  assert.match(only("O'Brien", ""), /LIKE '%O\\'Brien%'/);
});

test("a backslash is escaped BEFORE the quote", () => {
  /* Order matters and is easy to get backwards: escaping the quote first, then the
     backslash, would double the backslash this function had just inserted and leave the
     quote unescaped again. */
  assert.equal(escapeSoql("a\\'b"), "a\\\\\\'b");
});

test("LIKE wildcards are escaped, so the search means what was typed", () => {
  /* The browser version escaped only quotes and backslashes. "50% deposit" therefore
     matched every opportunity beginning "50", and "a_b" matched "axb" — quietly wrong
     results rather than an error, which is the worst kind. */
  assert.match(only("50% deposit", ""), /LIKE '%50\\% deposit%'/);
  assert.match(only("a_b", ""), /LIKE '%a\\_b%'/);
});

test("a term that tries to close the literal and add a clause cannot", () => {
  const evil = "x' OR Name != '";
  const soql = only(evil, "");
  // The injected quotes are escaped, so the whole thing stays one string literal.
  assert.match(soql, /LIKE '%x\\' OR Name != \\'%' ORDER BY Name/);
  // And nothing has escaped the literal to become SOQL: one WHERE, no OR outside quotes.
  assert.equal(soql.split("WHERE").length, 2);
});

// ── the mapped field, which is NOT escaped but validated ────────────────────
test("a valid mapped number field is selected", () => {
  assert.match(only("tetris", "Job_No__c"), /Owner\.Name, Job_No__c FROM/);
  assert.match(only("tetris", "Account.Number__c"), /Account\.Number__c FROM/);
});

test("anything that is not a bare API name is DROPPED, not escaped", () => {
  /* There is no safe way to quote an identifier into a SELECT list, so the only defence is
     refusing it. Each of these would otherwise change what the query reads. */
  for (const bad of [
    "Name FROM Opportunity WHERE Id!='' AND Name LIKE '%",
    "Id, (SELECT Id FROM Notes)",
    "Name; DROP",
    "Name Amount",
    "'Name'",
    "1Name",
    "",
    null,
  ]) {
    const soql = only("tetris", bad);
    assert.equal(soql.split("FROM").length, 2, `leaked a FROM: ${bad}`);
    assert.match(soql, /^SELECT Id, Name, StageName, CloseDate, Account\.Name, Owner\.Name FROM/,
      `not dropped: ${bad}`);
  }
});

// ── the progressive fallback ────────────────────────────────────────────────
test("three field sets when a number field is mapped, two when not", () => {
  /* One unreadable column fails the WHOLE query in Salesforce, so each set drops the most
     fragile part. With no mapped field the first two sets would be identical — deduped,
     because running the same failing query twice costs a round trip per keystroke. */
  assert.equal(buildSearchQuery("tetris", "Job_No__c").soqls.length, 3);
  assert.equal(buildSearchQuery("tetris", "").soqls.length, 2);
  assert.equal(buildSearchQuery("tetris", "not a field").soqls.length, 2);
});

test("the sets get progressively plainer, ending at Id and Name", () => {
  const s = buildSearchQuery("tetris", "Job_No__c").soqls;
  assert.match(s[0], /Job_No__c/);
  assert.doesNotMatch(s[1], /Job_No__c/);
  assert.match(s[1], /Account\.Name/);
  assert.match(s[2], /^SELECT Id, Name FROM/);
});

test("every set searches for the same thing, however plain", () => {
  // A fallback that quietly changed the search would be worse than no fallback.
  for (const soql of buildSearchQuery("O'Brien", "Job_No__c").soqls) {
    assert.match(soql, /WHERE Name LIKE '%O\\'Brien%' ORDER BY Name LIMIT 20$/);
  }
});
