// Read a MYOB Acumatica Generic Inquiry over OData.
//
// THE CHANNEL, verified against the live tenant 2026-09-10 (see probe-odata.js and the memory
// note): the contract REST API (/entity/Default/…) 403s for this tenant, but OData over Generic
// Inquiries answers 200 to Basic auth as a named user. It is the channel Velixo already uses, so
// no API entitlement has to be bought.
//
// Two facts from that run shape this module, and neither is obvious:
//
// 1 · A BASIC-AUTH REQUEST CREATES A SESSION. The response carried `set-cookie: UserBranch=1`, and
//     sessions — not requests — are what an Acumatica licence counts. A loop that authenticates
//     per call can exhaust the concurrent-session slots and lock real people out of MYOB. So the
//     cookie from the first response is carried on every later request in the same run: a whole
//     sync costs ONE session.
//
// 2 · IDENTIFIERS COME BACK SPACE-PADDED. `"ProjectID":"0018      "` — ten characters. An
//     untrimmed value joins to nothing in our tables and reports no error at all, which is the
//     worst kind of wrong. Every string is trimmed on the way in, once, here.
//
// The v4 route (/t/<tenant>/api/odata/gi/<inquiry>) is preferred over the classic /odata/<tenant>:
// the classic endpoint answers `dataserviceversion: 3.0` and the older JSON shape, while v4 gives
// predictable $select/$filter and @odata.context. Both work; this uses v4.

/* The URL for one page of an inquiry.
 *
 * $select is not decoration: asking for four columns instead of thirty is cheaper for them, makes
 * our intent legible in their logs, and means a column added to the inquiry cannot change what we
 * store. Everything is encoded — inquiry names contain spaces ("ALX_WIP Report") and the tenant
 * certainly does ("Alclad Architectural Live"). */
export function giUrl(instance, tenant, inquiry, { select = [], filter = '', top = 0, skip = 0, orderBy = '' } = {}) {
  const base = String(instance || '').replace(/\/+$/, '');
  const t = encodeURIComponent(String(tenant || '').trim());
  const gi = encodeURIComponent(String(inquiry || '').trim());
  const q = [];
  if (select.length) q.push('$select=' + select.map((c) => encodeURIComponent(c)).join(','));
  if (filter) q.push('$filter=' + encodeURIComponent(filter));
  /* $ORDERBY IS WHAT MAKES $SKIP MEAN ANYTHING. Paging an unordered result is undefined: the server
     may return a row on page 2 that it already gave on page 1, and omit another entirely. Over
     33,000 rows that is a silently short total nobody would question. Ordering on a unique column
     (TranID for ALX_JobTrans) pins the sequence so page N+1 resumes where page N stopped. */
  if (orderBy) q.push('$orderby=' + encodeURIComponent(orderBy));
  if (top) q.push('$top=' + Number(top));
  if (skip) q.push('$skip=' + Number(skip));
  return `${base}/t/${t}/api/odata/gi/${gi}${q.length ? '?' + q.join('&') : ''}`;
}

/* Trim every string, all the way down. Numbers and nulls pass through untouched — coercing them
   here would turn a genuine null amount into "" and then into 0 somewhere later, which is a
   figure nobody entered. */
export function trimRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

/* The Set-Cookie values worth sending back, as one Cookie header.
 *
 * Only the name=value pair — attributes (path, secure, HttpOnly) are instructions to a browser and
 * mean nothing on the way back. Returns '' when there was nothing, so a caller can send no Cookie
 * header at all rather than an empty one. */
export function cookieHeader(setCookieValues = []) {
  const pairs = [];
  for (const raw of setCookieValues) {
    const first = String(raw || '').split(';')[0].trim();
    if (first && first.includes('=')) pairs.push(first);
  }
  return pairs.join('; ');
}

/* Read an inquiry, paging until it stops giving full pages.
 *
 * `pageSize` bounds each request; `maxRows` bounds the whole read so a mistake in a filter cannot
 * pull a million rows into memory. Paging stops on a short page, which is the only signal OData
 * gives without asking for a count.
 *
 * fetchImpl is injectable so the paging, the cookie carry and the row cap are testable without a
 * live tenant — the parts that would otherwise only be exercised in production.
 */
export async function readInquiry({
  instance, tenant, inquiry, user, pass,
  /* maxRows GUARDS AGAINST A BAD FILTER, not against a big inquiry. ALX_JobTrans returned 52,970
     rows on 2026-09-10 — over half the old 100,000 cap — and it grows with every transaction ever
     posted, so that cap was a year or two from being hit. Hitting it is now safe rather than
     destructive (the read reports incomplete and the sweep refuses), but the failure is a silently
     stale hub, so give it real headroom and revisit with a period filter long before this. */
  select = [], filter = '', orderBy = '', pageSize = 500, maxRows = 1000000,
  cookie: cookieIn = '', fetchImpl = fetch,
} = {}) {
  if (!instance || !tenant || !inquiry) throw new Error('readInquiry needs instance, tenant and inquiry');
  if (!user || !pass) throw new Error('readInquiry needs a username and password');
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const rows = [];
  /* Handed in when a run has already authenticated. Two inquiries would otherwise open two
     sessions, and sessions are what the licence counts. */
  let cookie = cookieIn;
  let requests = 0;
  /* WAS THE WHOLE INQUIRY READ? Only a short page proves it. Hitting maxRows instead means the
     read stopped early, and the caller MUST know: a sweep after a truncated read deletes precisely
     the projects the read never reached. syncActuals had `complete: true` hardcoded, which made its
     own guard against that unreachable — so this is reported, not assumed. */
  let complete = false;
  for (let skip = 0; rows.length < maxRows; skip += pageSize) {
    const url = giUrl(instance, tenant, inquiry, { select, filter, orderBy, top: pageSize, skip });
    const headers = { Authorization: auth, Accept: 'application/json' };
    /* ONE SESSION PER RUN — see the note at the top. */
    if (cookie) headers.Cookie = cookie;
    const res = await fetchImpl(url, { headers });
    requests++;
    if (!cookie) {
      const sc = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie()
        : (res.headers?.get?.('set-cookie') ? [res.headers.get('set-cookie')] : []);
      cookie = cookieHeader(sc);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`MYOB OData ${res.status} on ${inquiry}: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    const page = Array.isArray(json.value) ? json.value : [];
    for (const r of page) rows.push(trimRow(r));
    /* A SHORT PAGE IS THE END. Asking again after one would loop for ever against a server that
       ignores $skip — which is exactly how a nightly job becomes an outage. */
    if (page.length < pageSize) { complete = true; break; }
  }
  return {
    rows: rows.slice(0, maxRows), requests, complete, cookie,
    sessionReused: (requests > 1 || !!cookieIn) && !!cookie,
  };
}

/* The actuals feed, rolled up to the grain the hub compares at.
 *
 * WHY ALX_JobTrans AND NOT PMHistoryByDateMaster. The first attempt read
 * VelixoReportsPro-PMHistoryByDateMaster, chosen from its column names, and the dry run against the
 * live tenant (2026-09-10) killed it on two counts:
 *
 *   · Its ProjectID is an INTERNAL INTEGER (145, 129, 82) — not the 6931-style job code the same
 *     column name returns in ALX_Projects. Keyed on that, every row would have matched no hub
 *     project, and the hub would have shown no actuals on every job: indistinguishable from "the
 *     feed isn't finished yet".
 *   · Its rows span every account group, income as well as expense, so a project total came out at
 *     10.7M — revenue and cost added together.
 *
 * ALX_JobTrans is Alclad's own inquiry and answers in the business's own terms: Project is the job
 * CODE ("6931      ", padded — trimRow handles that), AccountGroup is a WORD (STAFF, MATERIAL), and
 * CostCodeGrp names the package (CLADDING). It also carries the detail PMHistory never had —
 * employee, supplier, PO reference, description — so drill-down is a filter on the same inquiry
 * rather than a second integration.
 *
 * Amount vs Amount_2: identical in all 60 sample rows (base vs transaction currency, the same while
 * the ledger is AUD-only). Amount is the one read; if they ever diverge that is a currency question
 * worth answering deliberately, not silently.
 *
 * Amounts are PER-TRANSACTION MOVEMENTS, not running balances — verified on reversals that book the
 * negative and the positive as separate rows (TranID 54170 +5343.84, 54172 -5343.75 on one sheet).
 * So summing is correct, and a reversed cost nets to nothing exactly as the ledger intends.
 *
 * ⚠ A project with no MYOB row is NORMAL: 7336 Newcold is a quote, not a won job. Absence must
 * read as "not yet", never as a broken link. */
export const ACTUALS_INQUIRY = 'ALX_JobTrans';
/* ProjectName is carried because a NUMBER alone cannot tell you that two MYOB jobs are one real
   job. Alclad numbers some jobs once per package (glazing 6930, cladding 6931) while the hub holds
   the lower number, so a link made on the number alone would silently omit a package's cost — a
   figure that looks entirely plausible and is short by a whole scope. With the name stored, sibling
   numbers can be spotted and linked deliberately. */
export const ACTUALS_SELECT = ['Project', 'ProjectName', 'CostCode', 'AccountGroup', 'CostCodeGrp', 'FinPeriod', 'Amount', 'Qty', 'TranID'];
/* Unique per transaction, so paging is deterministic — see the $orderby note in giUrl. */
export const ACTUALS_ORDER = 'TranID';

/* Which account groups are COST, read from the tenant rather than hardcoded.
 *
 * The first sync summed every group and reported 10.7M on a single project: Alclad bills revenue
 * through account groups named after the PACKAGES (GLAZING, CLADDING, RECLAD, FINS — all Income)
 * and costs through groups named by CATEGORY (MATERIAL, STAFF, SUBCONT, EQUIP, LABOUR, OTHER,
 * CONSULT — all Expense). Added together they cancel into a number that means nothing.
 *
 * A hardcoded list of the seven would silently drop a group added later, and a dropped cost group
 * reads as an underspent job — the kind of wrong nobody queries. So the Type column decides, and a
 * new group classified in MYOB works here with no code change.
 *
 * ⚠ NOT filtered on Active. A deactivated group still has history, and historic costs are still
 * costs; excluding them would quietly shrink finished jobs. */
export const GROUPS_INQUIRY = 'VelixoReportsPro-AccountGroups';
export const GROUPS_SELECT = ['AccountGroupCD', 'Type', 'Active'];

export function classifyGroups(rows = []) {
  const byCode = new Map();
  const cost = new Set();
  const income = new Set();
  for (const r of rows) {
    const code = String(r.AccountGroupCD ?? '').trim();
    if (!code) continue;
    const type = String(r.Type ?? '').trim().toLowerCase();
    byCode.set(code, type);
    if (type === 'expense') cost.add(code);
    else if (type === 'income') income.add(code);
  }
  return { byCode, cost, income };
}

/* Groups present in the ledger that the classification has never heard of.
 *
 * This should be empty — both come from the same tenant. If it is not, the group is either new
 * income (which would corrupt every total it touches) or new cost (which would be missing from
 * them), and there is no safe way to guess which. The caller refuses to sync. */
export function unknownGroups(rows = [], byCode = new Map()) {
  const seen = new Set();
  for (const row of rows) {
    const code = String(row.AccountGroup ?? '').trim();
    /* A BLANK GROUP COUNTS AS UNKNOWN. It cannot be classified, so it would be filtered out of the
       cost roll-up and disappear into the (large, expected) income exclusion without trace. */
    if (!code) { seen.add('(blank)'); continue; }
    if (!byCode.has(code)) seen.add(code);
  }
  return [...seen].sort();
}

export function rollUpActuals(rows = [], { costGroups = null, incomeGroups = null } = {}) {
  const by = new Map();
  for (const r of rows) {
    const project = String(r.Project ?? '').trim();
    if (!project) continue;              // a row with no project cannot be attributed to anything
    const group = String(r.AccountGroup ?? '').trim();
    /* COST AND INCOME ARE BOTH KEPT, in separate columns.
     *
     * Passing neither set means no filtering, which suits a caller that has already filtered and
     * would be wrong for the sync — syncActuals always passes both. Passing costGroups alone keeps
     * the old cost-only behaviour, so nothing that predates income has to change.
     *
     * A row in NEITHER set is dropped here. syncActuals refuses the whole run when an unclassified
     * group appears, so reaching this line means the caller chose to filter loosely and is
     * responsible for that. */
    const isCost = !costGroups || costGroups.has(group);
    const isIncome = !!incomeGroups && incomeGroups.has(group);
    if (!isCost && !isIncome) continue;
    const costCode = String(r.CostCode ?? '').trim();
    const period = String(r.FinPeriod ?? '').trim();
    const key = `${project}|${costCode}|${period}`;
    const cur = by.get(key) || {
      project_id: project, cost_code: costCode,
      /* BLANK UNTIL A COST ROW SETS IT. Seeding this with whatever group arrived first put INCOME
         groups into a column the hub renders as "Cost types" — 6242 COS Melton DC displayed
         'CLADDING,EQUIP,MATERIAL,OTHER,STAFF,SUBCONT', and CLADDING is revenue. A reader would take
         it for a cost category. income_amount already says revenue is present; this column is only
         ever about cost. */
      account_group: '',
      /* MYOB's own description of the job. Blank rather than null so a reader never has to handle
         both, and first-seen-wins: if the name were edited mid-period the figures are the same job
         either way, and the linker only needs it to recognise siblings. */
      project_name: String(r.ProjectName ?? '').trim(),
      fin_period: period, actual_amount: 0, income_amount: 0, actual_qty: 0, rows: 0,
    };
    /* A later row can fill a name an earlier one lacked, but never blank one that is already set. */
    if (!cur.project_name) cur.project_name = String(r.ProjectName ?? '').trim();
    /* THE ACCOUNT GROUP ON A MIXED ROW. One project/cost-code/period can carry both cost and
       income lines, and a single column cannot describe both — so a mixed row is labelled from the
       COST side, which is what the register's figure is about. The view exposes the full set of
       groups behind a project anyway, and income_amount being non-zero says the rest. */
    if (isCost && !cur.account_group) cur.account_group = group;
    /* Number(null) is 0 but Number(undefined) is NaN, and a NaN poisons the whole sum silently —
       so anything unparseable contributes nothing rather than destroying the total. */
    const amt = Number(r.Amount);
    const qty = Number(r.Qty);
    const n = Number.isFinite(amt) ? amt : 0;
    if (isCost) {
      cur.actual_amount += n;
      cur.actual_qty += Number.isFinite(qty) ? qty : 0;
    } else {
      /* INCOME IS STORED POSITIVE. MYOB books project revenue as a CREDIT, so these arrive negative
         — GLAZING summed to -52,503,187.06 across the ledger. The MYOB Projects screen shows
         "Actual Income 6,466,337.95" as a positive figure, and a hub that showed -6,466,337.95
         would invite someone to add it to cost rather than compare it. Negated once, here, at the
         edge, for the same reason identifiers are trimmed here. */
      cur.income_amount += -n;
    }
    cur.rows += 1;
    by.set(key, cur);
  }
  /* Rounded to cents at the end, not per row: rounding each addend first is how a total drifts
     away from the ledger by a few cents per hundred lines. */
  return [...by.values()].map(({ account_group_is_cost, ...v }) => ({
    ...v,
    actual_amount: Math.round(v.actual_amount * 100) / 100,
    income_amount: Math.round(v.income_amount * 100) / 100,
    actual_qty: Math.round(v.actual_qty * 10000) / 10000,
  }));
}

/* What each account group contributes, biggest first.
 *
 * The 10.7M figure was revenue and cost summed together, and nothing in the roll-up could have
 * shown that — one number per project hides which groups made it. This breaks a read down by group
 * so the dry run can say STAFF / MATERIAL / whatever else in the ledger, with a total each. If a
 * group that is plainly income appears, it is visible before anything is written rather than
 * discovered later in a project total that looks a bit high. */
export function groupTotals(rows = []) {
  const by = new Map();
  for (const r of rows) {
    const g = String(r.AccountGroup ?? '').trim() || '(none)';
    const amt = Number(r.Amount);
    const cur = by.get(g) || { account_group: g, amount: 0, rows: 0 };
    cur.amount += Number.isFinite(amt) ? amt : 0;
    cur.rows += 1;
    by.set(g, cur);
  }
  return [...by.values()]
    .map((v) => ({ ...v, amount: Math.round(v.amount * 100) / 100 }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}
