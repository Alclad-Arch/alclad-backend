// Ask ONLY the OData surface — no Connected Application, no Supabase, no stored token.
//
//   node probe-odata.js
//
// probe-myob.js needs MYOB_CLIENT_ID / _SECRET and a Supabase service key, because it exercises
// the OAuth service identity end to end. None of that is needed to answer the question Jed asked
// on 2026-09-10: Velixo already pulls live data out of this tenant into Excel, so can the app read
// the same way instead of buying the REST API entitlement?
//
// An Excel add-in signs in as a NAMED USER over Basic auth. That needs three things — the server
// URL, a username and a password — all of which are visible in Velixo's own connection settings.
// So this asks with exactly those, and nothing else.
//
// Needs, in this shell or a .env:
//   MYOB_INSTANCE_URL   e.g. https://<company>.myobadvanced.com   (Velixo calls it the server URL)
// Optional, and SKIPPED rather than guessed when unset:
//   MYOB_TENANT         the company/tenant segment
//   MYOB_GI             a Generic Inquiry name, to pull one row rather than just the catalogue
//   MYOB_ODATA_USER     ) the user Velixo signs in as. Never printed.
//   MYOB_ODATA_PASS     )
//
// Read-only: every request is a GET, and nothing is written anywhere.
import "dotenv/config";
import { odataCandidates, readOdataStatus, authHeader } from "./myobOdata.js";

const instance = process.env.MYOB_INSTANCE_URL || "";
if (!instance) {
  console.error("\nMYOB_INSTANCE_URL is not set — that is the only thing this needs.");
  console.error("It is the server URL in Velixo's connection settings, e.g.");
  console.error("  https://<company>.myobadvanced.com\n");
  console.error("PowerShell, for one run:");
  console.error('  $env:MYOB_INSTANCE_URL = "https://<company>.myobadvanced.com"');
  console.error('  $env:MYOB_ODATA_USER = "<the user Velixo signs in as>"');
  console.error('  $env:MYOB_ODATA_PASS = "<its password>"');
  console.error("  node probe-odata.js\n");
  process.exit(1);
}

const tenant = process.env.MYOB_TENANT || "";
const gi = process.env.MYOB_GI || "";
const user = process.env.MYOB_ODATA_USER || "";
const pass = process.env.MYOB_ODATA_PASS || "";

console.log(`\nMYOB OData probe — the surface an Excel add-in reads\n${instance}`);
console.log(`tenant: ${tenant || "(unset — tenant-scoped addresses skipped, not guessed)"}`);
console.log(`inquiry: ${gi || "(unset — the service document still lists what is exposed)"}`);
console.log(`credentials: ${user && pass ? `Basic as ${user}` : "NONE — set MYOB_ODATA_USER / MYOB_ODATA_PASS"}`);

/* Anonymous first, deliberately. If the service document answers without credentials that is
   worth knowing on its own — and it separates "this address exists" from "these credentials
   work", which is the distinction the whole exercise turns on. */
const modes = [["none", null]];
if (user && pass) {
  modes.push(["basic", authHeader("basic", { user, pass })]);
  /* Acumatica-family tenants commonly want the company folded into the username as
     `user@tenant` — a bare username then 401s exactly like a wrong password, which is a whole
     round trip wasted on a formatting convention. Tried automatically when a tenant is known and
     the username does not already carry one. */
  if (tenant && !user.includes("@")) {
    modes.push([`basic@t`, authHeader("basic", { user: `${user}@${tenant}`, pass })]);
  }
}

const rows = [];
for (const [mode, header] of modes) {
  for (const c of odataCandidates(instance, tenant, gi)) {
    try {
      const res = await fetch(c.url, {
        headers: { Accept: "application/json", ...(header ? { Authorization: header } : {}) },
      });
      const { verdict, note } = readOdataStatus(res.status);
      let detail = note;
      /* WHAT THE SERVER SAYS IT WANTS. A 401 carries WWW-Authenticate naming the scheme and
         often the realm, which answers "Basic or Bearer?" instead of us inferring it. */
      if (res.status === 401) {
        const ch = res.headers.get("www-authenticate");
        if (ch) detail = `wants: ${ch.slice(0, 70)} · ${note}`;
      }
      if (res.status === 200) {
        const text = await res.text().catch(() => "");
        detail = text.replace(/\s+/g, " ").slice(0, 110) + "…";
      }
      rows.push([mode, c.label, `${res.status} ${verdict}`, detail]);
    } catch (e) {
      rows.push([mode, c.label, "UNREACHABLE", String((e && e.message) || e).slice(0, 90)]);
    }
  }
}

const w = (s, n) => String(s).padEnd(n);
console.log("\n" + w("AUTH", 7) + w("ADDRESS", 22) + w("RESULT", 18) + "WHAT IT MEANS");
console.log("-".repeat(112));
for (const r of rows) console.log(w(r[0], 7) + w(r[1], 22) + w(r[2], 18) + r[3]);

const basic = rows.filter((r) => r[0].startsWith("basic"));
const open = basic.filter((r) => /OPEN/.test(r[2]));
const auth = basic.filter((r) => /AUTH/.test(r[2]));
const refused = basic.filter((r) => /REFUSED/.test(r[2]));
const anonReachable = rows.some((r) => r[0] === "none" && !/UNREACHABLE|NO SUCH URL/.test(r[2]));

console.log("");
if (open.length) {
  console.log("FINDING: OData ANSWERS as this user. That is almost certainly how Velixo reads the");
  console.log("tenant, and the app can read it the same way — the actuals the hub needs could come");
  console.log("through without buying the REST entitlement.");
  console.log("Next: expose exactly the figures the hub needs as a Generic Inquiry and read that one");
  console.log("address, rather than reaching for whole entities. And confirm with MYOB/Velixo that a");
  console.log("second client on this channel is within licence — that part is commercial, not technical.");
} else if (auth.length) {
  console.log("FINDING: the surface EXISTS and did not accept these credentials. Worth checking the");
  console.log("username is the exact one in Velixo's connection (often a dedicated integration user),");
  console.log("and whether this tenant wants 'user@tenant' rather than a bare username.");
} else if (refused.length) {
  console.log("FINDING: authenticated and refused — the same wall as the REST entities, on a second");
  console.log("door. That points at a tenant-level entitlement rather than anything configurable.");
  console.log("Since Velixo plainly does read this tenant, ask MYOB how it is authorised: whatever");
  console.log("they answer names the channel we should be using.");
} else if (!user || !pass) {
  console.log(`FINDING: no credentials supplied, so this only says which addresses exist${anonReachable ? " (some answered)" : ""}.`);
  console.log("Open Velixo in Excel, look at its connection settings, and re-run with the server URL,");
  console.log("tenant and user it is configured with. That is the whole question.");
} else {
  console.log("FINDING: nothing answered. Take the real address from Velixo's connection settings —");
  console.log("every shape here is a guess at how the tenant is provisioned, and a 404 is not a");
  console.log("rights answer.");
}
console.log("");
