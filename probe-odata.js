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

/* A LIST, comma-separated. The segment in an OData URL is the company/tenant ID from the login
   screen's Company dropdown, which is sometimes the display name ("Alclad Architectural Live")
   and sometimes a short code — and a wrong one 404s, which is explicitly not a rights answer. So
   rather than one guess per round trip, try every candidate in one run:
     $env:MYOB_TENANT = "Alclad Architectural Live,AlcladArchitectural,Alclad"
   Empty means the tenant-scoped shapes are skipped entirely, as before. */
const tenants = (process.env.MYOB_TENANT || "").split(",").map((t) => t.trim()).filter(Boolean);
const tenant = tenants[0] || "";
/* A LIST too. 87 inquiries are exposed on this tenant, so the useful question is which of a
   handful carries the columns the hub needs — and inspecting them one run at a time is the same
   avoidable round trip that guessing tenants was.
     $env:MYOB_GI = "ALX_JobTrans,VelixoReportsPro-PMHistoryByDateMaster,ALX_Projects" */
const gis = (process.env.MYOB_GI || "").split(",").map((g) => g.trim()).filter(Boolean);
const gi = gis[0] || "";
/* How many rows to ask for. One is enough to learn the columns, which is the usual question;
   a few more is how you learn what the IDENTIFIERS look like — whether MYOB's ProjectID is the
   job number the hub uses. */
const top = Math.max(1, Math.min(2000, Number(process.env.MYOB_TOP || 1) || 1));
/* Rows are NOT printed unless asked for. The columns answer "can this inquiry feed the hub";
   the values are ledger figures, and putting those in a terminal by default serves nothing.
   MYOB_SHOW=1 prints them, for the one job it is genuinely needed for: working out how MYOB's
   ProjectID lines up with the hub's job numbers. */
const show = process.env.MYOB_SHOW === "1";
/* MYOB_FIND=6667,6931 prints ONLY the rows containing one of those strings.
 *
 * The mapping question — is the hub's job number MYOB's ProjectID — needs a needle from a few
 * hundred rows, and MYOB_SHOW on a large $top answers it by burying it. Matching is done on the
 * TRIMMED values because ProjectID comes back space-padded ("0018      "), which is exactly the
 * kind of difference that makes a join quietly match nothing. */
const finds = (process.env.MYOB_FIND || "").split(",").map((f) => f.trim()).filter(Boolean);
const user = process.env.MYOB_ODATA_USER || "";
const pass = process.env.MYOB_ODATA_PASS || "";

console.log(`\nMYOB OData probe — the surface an Excel add-in reads\n${instance}`);
console.log(`tenant: ${tenants.length ? tenants.join(" | ") : "(unset — tenant-scoped addresses skipped, not guessed)"}`);
console.log(`inquiry: ${gis.length ? gis.join(" | ") : "(unset — the service document still lists what is exposed)"}`);
console.log(`credentials: ${user && pass ? `Basic as ${user}` : "NONE — set MYOB_ODATA_USER / MYOB_ODATA_PASS"}`);
console.log(`rows: $top=${top}${show ? " · MYOB_SHOW=1, values will be printed" : " · columns only (MYOB_SHOW=1 to print values)"}${finds.length ? ` · looking for ${finds.join(", ")}` : ""}`);

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
  /* One per candidate: with several tenant guesses, only trying the first would leave the right
     one untested and report a 401 that looks like a wrong password. */
  if (!user.includes("@")) {
    for (const t of tenants) {
      modes.push([`u@${t.slice(0, 4)}`, authHeader("basic", { user: `${user}@${t}`, pass })]);
    }
  }
}

/* One pass per tenant candidate, plus a pass with no tenant so the un-scoped addresses are still
   asked exactly once rather than repeated per candidate. */
const passes = tenants.length ? tenants.map((t) => t) : [""];
const seen = new Set();
const rows = [];
const exposed = [];   // [label, [inquiry names]] for every catalogue that answered
const columns = [];   // [label, [field names]] for every inquiry that returned a row
const samples = [];   // [label, rows] only when MYOB_SHOW=1
const matches = [];   // [label, hits, scanned] only when MYOB_FIND is set
for (const [mode, header] of modes) {
  for (const t of passes) {
  for (const g of (gis.length ? gis : [""])) {
  for (const c of odataCandidates(instance, t, g)) {
    /* An un-scoped address is identical for every candidate — ask it once. */
    const key = `${mode}|${c.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let label = t && c.label.includes('tenant') ? `${c.label} ${t.slice(0, 10)}` : c.label;
    /* Name the inquiry rather than the route when one was asked for — with several in a run,
       "GI (classic)" four times over says nothing about which answered. */
    if (g && c.label.startsWith('GI')) label = `GI ${g.slice(0, 26)}`;
    try {
      const url = c.url.replace("$top=1", `$top=${top}`);
      const res = await fetch(url, {
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
        detail = text.replace(/\s+/g, " ").slice(0, 90) + "…";
        /* WHAT IS ACTUALLY EXPOSED. A service document / GI catalogue answers with the list of
           readable inquiries, and that list is the whole point: it decides whether the actuals
           the hub needs are already available or whether a Generic Inquiry has to be exposed
           first. Both shapes put the names in value[].name. Collected rather than printed here so
           the table stays a table. */
        try {
          const j = JSON.parse(text);
          const first = (j.value || [])[0];
          /* A CATALOGUE lists inquiries (value[].name); a DATA row is the inquiry's own fields.
             The fields decide whether an inquiry carries what the hub needs, so they are worth
             far more than a truncated blob of the row — and printing the row would put ledger
             figures in a terminal for no reason. */
          if (!g && first && (first.name || first.url)) {
            const names = (j.value || []).map((v) => v && (v.name || v.url)).filter(Boolean);
            if (names.length) exposed.push([label, names]);
          } else if (first && typeof first === 'object') {
            columns.push([label, Object.keys(first)]);
            detail = `${(j.value || []).length} row(s), ${Object.keys(first).length} column(s)`;
            if (finds.length) {
              /* Trimmed on both sides, and matched against every value in the row rather than a
                 named column: which column carries the identifier is part of what is being
                 worked out. */
              const hits = (j.value || []).filter((row) => Object.values(row).some((v) =>
                finds.some((f) => String(v == null ? "" : v).trim().includes(f))));
              matches.push([label, hits, (j.value || []).length]);
            } else if (show) samples.push([label, j.value]);
          } else {
            /* 200 with NO rows is its own finding, not a blank: an inquiry that needs
               parameters answers exactly like this, and reading it as "empty" would write the
               feed off for the wrong reason. */
            detail = "200 but ZERO rows — the inquiry may need parameters";
          }
        } catch { /* not JSON — the raw sample above already says so */ }
      }
      rows.push([mode, label, `${res.status} ${verdict}`, detail]);
    } catch (e) {
      rows.push([mode, label, "UNREACHABLE", String((e && e.message) || e).slice(0, 90)]);
    }
  }
  }
  }
}

/* A 403 NEXT TO 200s MEANS SOMETHING ELSE. readOdataStatus reads one status at a time, so it
   calls every 403 "the same wall as the REST entities" — which is right when everything is
   refused and wrong when a single inquiry is. Acumatica restricts Generic Inquiries per role, so
   one refusal among successes is an access right ON THAT INQUIRY, and telling the two apart is
   the difference between "ask for that GI to be shared" and "buy an entitlement". */
{
  const anyOpen = rows.some((r) => /OPEN/.test(r[2]));
  if (anyOpen) {
    for (const r of rows) {
      if (/REFUSED/.test(r[2])) {
        r[3] = "refused while OTHER inquiries answered — an access right on this inquiry, not the tenant";
      }
    }
  }
}

/* Truncated as well as padded: a label longer than its column pushes RESULT out of line and the
   table stops being scannable, which is most of what a probe is for. */
const w = (s, n) => String(s).slice(0, n - 1).padEnd(n);
console.log("\n" + w("AUTH", 9) + w("ADDRESS", 34) + w("RESULT", 18) + "WHAT IT MEANS");
console.log("-".repeat(118));
for (const r of rows) console.log(w(r[0], 9) + w(r[1], 34) + w(r[2], 18) + r[3]);

const basic = rows.filter((r) => r[0] !== "none");
const open = basic.filter((r) => /OPEN/.test(r[2]));
const auth = basic.filter((r) => /AUTH/.test(r[2]));
const refused = basic.filter((r) => /REFUSED/.test(r[2]));
const anonReachable = rows.some((r) => r[0] === "none" && !/UNREACHABLE|NO SUCH URL/.test(r[2]));

/* THE LIST. When a catalogue answers, what it lists is the actionable finding: it names every
   inquiry this credential can read, which is what decides whether the hub can be fed today or
   whether a Generic Inquiry has to be exposed in MYOB first. */
if (exposed.length) {
  for (const [label, names] of exposed) {
    console.log(`\nEXPOSED via ${label} — ${names.length} readable:`);
    const show = names;   // all of them: finding the one that fits is the point
    for (const n of show) console.log(`  ${n}`);
  }
}

/* The columns of each inquiry asked for — the finding that decides which one feeds the hub. */
for (const [label, cols] of columns) {
  console.log(`\nCOLUMNS of ${label} — ${cols.length}:`);
  console.log('  ' + cols.join(', '));
}

/* The needle, and how big the haystack was — "0 of 15" and "0 of 800" mean very different
   things, and without the count the first reads as a definitive no. */
for (const [label, hits, scanned] of matches) {
  console.log(`\nFOUND in ${label} — ${hits.length} of ${scanned} row(s) scanned:`);
  for (const h of hits) console.log('  ' + JSON.stringify(h));
  if (!hits.length) {
    console.log(`  none. If ${scanned} is the whole inquiry, these ids are not in it; if it is`);
    console.log('  just the first page, raise MYOB_TOP and look again.');
  }
}

for (const [label, rowsOut] of samples) {
  console.log(`\nROWS of ${label} — ${rowsOut.length}:`);
  for (const r of rowsOut) console.log('  ' + JSON.stringify(r));
}

console.log("");
if (open.length) {
  console.log("FINDING: OData ANSWERS as this user. That is almost certainly how Velixo reads the");
  console.log("tenant, and the app can read it the same way — the actuals the hub needs could come");
  console.log("through without buying the REST entitlement.");
  console.log("Next: expose exactly the figures the hub needs as a Generic Inquiry and read that one");
  console.log("address, rather than reaching for whole entities. And confirm with MYOB/Velixo that a");
  console.log("second client on this channel is within licence — that part is commercial, not technical.");
  if (rows.some((r) => /REFUSED/.test(r[2]))) {
    console.log("");
    console.log("One inquiry was refused while others answered — that is a per-inquiry access right,");
    console.log("granted on the Generic Inquiry itself, and it does not affect the rest.");
  }
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
