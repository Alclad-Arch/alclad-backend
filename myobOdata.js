// Which OData surface, if any, this MYOB Acumatica tenant will answer on.
//
// WHY THIS EXISTS. Every contract-based REST entity (/entity/Default/<version>/…) 403s for our
// service identity, and roles, grants, tenant and scope were all eliminated as causes — the
// remaining explanation is that the tenant is not entitled to that API. Buying the entitlement is
// the obvious next step and it costs money.
//
// But Velixo is already extracting live ERP data into Excel from this same tenant (Jed,
// 2026-09-10). So SOME extraction channel is authorised today. Acumatica-based systems expose
// OData over Generic Inquiries as a surface SEPARATE from the contract REST API, with its own
// entitlement and its own auth, and an Excel reporting add-in is exactly the kind of client that
// uses it. If that is the channel Velixo holds, the app may be able to use it too — and nothing
// needs buying.
//
// This is NOT a retry of what was eliminated. Those findings were about /entity/Default; this is
// a different surface. Read a 403 here as "the same wall, on the other door" and a 200 as "the
// door Velixo came through".
//
// Kept as its own module so the URL shapes can be unit-tested. A diagnostic that quietly probes
// the wrong address reports a confident 404 and sends someone off buying a licence they may not
// need — the failure mode a probe must never have.

/* Every OData address an Acumatica-family tenant is plausibly reachable on.
 *
 * The shapes differ by version and by how the tenant was provisioned, and we cannot know which
 * from here — so ask all of them and let the STATUS say which is real. `tenant` is optional: the
 * tenant-scoped forms are simply skipped without it rather than being built with "undefined" in
 * the path, which would 404 and read like a refusal.
 *
 * The service-document root is asked first in each family because it answers with the LIST of
 * available inquiries — which is both the cheapest possible request and, if it answers, the
 * answer to "what can we actually read". */
export function odataCandidates(instance, tenant, gi) {
  const base = String(instance || '').replace(/\/+$/, '');
  const t = String(tenant || '').trim();
  const name = String(gi || '').trim();
  const out = [];
  const add = (label, url, why) => out.push({ label, url, why });

  // ── the classic surface: /OData, optionally scoped by company/tenant ──
  add('OData root', `${base}/OData`, 'the service document — lists every exposed inquiry');
  if (t) add('OData root (tenant)', `${base}/OData/${encodeURIComponent(t)}`, 'same, scoped to the company');

  // ── the newer route, used by recent Acumatica builds ──
  if (t) add('OData v4 GI (tenant)', `${base}/t/${encodeURIComponent(t)}/api/odata/gi`,
    'the /t/<tenant>/api/odata/gi form used by newer builds');
  add('OData v4 GI', `${base}/api/odata/gi`, 'the same without a tenant segment');

  // ── a named Generic Inquiry, if one was given ──
  if (name) {
    add('GI (classic)', `${base}/OData/${t ? encodeURIComponent(t) + '/' : ''}${encodeURIComponent(name)}?$top=1`,
      'one row from the named inquiry');
    add('GI (v4)', `${base}${t ? `/t/${encodeURIComponent(t)}` : ''}/api/odata/gi/${encodeURIComponent(name)}?$top=1`,
      'the same inquiry on the v4 route');
  }
  return out;
}

/* What a status code MEANS on this surface — the whole point of the exercise, because the
   difference between 401 and 403 decides whether the next step is a credential or a purchase
   order. Kept next to the codes so the probe cannot describe them inconsistently. */
export function readOdataStatus(status) {
  if (status === 200) return { verdict: 'OPEN', note: 'this surface answers — the channel Velixo uses may be usable directly' };
  if (status === 401) return { verdict: 'AUTH', note: 'reachable, but it rejected these credentials — OData classically wants Basic auth as a named user, not the OAuth bearer' };
  if (status === 403) return { verdict: 'REFUSED', note: 'authenticated and refused — the same wall as the REST entities, on a second door' };
  if (status === 404) return { verdict: 'NO SUCH URL', note: 'wrong shape for this tenant, or the inquiry is not exposed — not a rights answer' };
  if (status === 405) return { verdict: 'WRONG METHOD', note: 'the endpoint exists but not for GET on this path — the surface is there' };
  if (status >= 500) return { verdict: 'SERVER ERROR', note: 'the endpoint exists and broke — a malformed request, not a refusal' };
  return { verdict: `HTTP ${status}`, note: '' };
}

/* Basic auth is offered because it is the shape an Excel add-in signs in with, and it is the
   likeliest reason a bearer token gets a 401 here while Velixo works. Credentials come from the
   environment and are never printed — the probe reports only WHICH mode was used. */
export function authHeader(mode, { token, user, pass } = {}) {
  if (mode === 'basic') {
    if (!user || !pass) return null;
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }
  return token ? `Bearer ${token}` : null;
}
