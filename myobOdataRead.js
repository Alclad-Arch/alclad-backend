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
export function giUrl(instance, tenant, inquiry, { select = [], filter = '', top = 0, skip = 0 } = {}) {
  const base = String(instance || '').replace(/\/+$/, '');
  const t = encodeURIComponent(String(tenant || '').trim());
  const gi = encodeURIComponent(String(inquiry || '').trim());
  const q = [];
  if (select.length) q.push('$select=' + select.map((c) => encodeURIComponent(c)).join(','));
  if (filter) q.push('$filter=' + encodeURIComponent(filter));
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
  select = [], filter = '', pageSize = 500, maxRows = 100000,
  fetchImpl = fetch,
} = {}) {
  if (!instance || !tenant || !inquiry) throw new Error('readInquiry needs instance, tenant and inquiry');
  if (!user || !pass) throw new Error('readInquiry needs a username and password');
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const rows = [];
  let cookie = '';
  let requests = 0;
  for (let skip = 0; rows.length < maxRows; skip += pageSize) {
    const url = giUrl(instance, tenant, inquiry, { select, filter, top: pageSize, skip });
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
    if (page.length < pageSize) break;
  }
  return { rows: rows.slice(0, maxRows), requests, sessionReused: requests > 1 && !!cookie };
}

/* The actuals feed, rolled up to the grain the hub compares at.
 *
 * VelixoReportsPro-PMHistoryByDateMaster is per DATE, so a project/cost-code/period appears many
 * times. The hub shows budget-vs-actual per cost code, so the rows are summed to
 * (project, cost code, period) here rather than stored raw: it is the figure that gets displayed,
 * it keeps the table small, and rolling a job total out of it is trivial. Drill-down, when it is
 * wanted, comes from ALX_JobTrans on demand — that is a different question and a different read.
 *
 * ⚠ A project with no MYOB row is NORMAL: 7336 Newcold is a quote, not a won job. Absence must
 * read as "not yet", never as a broken link. */
export const ACTUALS_INQUIRY = 'VelixoReportsPro-PMHistoryByDateMaster';
export const ACTUALS_SELECT = ['ProjectID', 'CostCodeID', 'AccountGroupID', 'FinPeriodID', 'ActualAmount', 'ActualQty'];

export function rollUpActuals(rows = []) {
  const by = new Map();
  for (const r of rows) {
    const project = String(r.ProjectID ?? '').trim();
    if (!project) continue;              // a row with no project cannot be attributed to anything
    const costCode = String(r.CostCodeID ?? '').trim();
    const period = String(r.FinPeriodID ?? '').trim();
    const key = `${project}|${costCode}|${period}`;
    const cur = by.get(key) || {
      project_id: project, cost_code: costCode, account_group: String(r.AccountGroupID ?? '').trim(),
      fin_period: period, actual_amount: 0, actual_qty: 0, rows: 0,
    };
    /* Number(null) is 0 but Number(undefined) is NaN, and a NaN poisons the whole sum silently —
       so anything unparseable contributes nothing rather than destroying the total. */
    const amt = Number(r.ActualAmount);
    const qty = Number(r.ActualQty);
    cur.actual_amount += Number.isFinite(amt) ? amt : 0;
    cur.actual_qty += Number.isFinite(qty) ? qty : 0;
    cur.rows += 1;
    by.set(key, cur);
  }
  /* Rounded to cents at the end, not per row: rounding each addend first is how a total drifts
     away from the ledger by a few cents per hundred lines. */
  return [...by.values()].map((v) => ({
    ...v,
    actual_amount: Math.round(v.actual_amount * 100) / 100,
    actual_qty: Math.round(v.actual_qty * 10000) / 10000,
  }));
}
