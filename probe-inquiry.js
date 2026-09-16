// Probe ANY Generic Inquiry — READ ONLY, nothing is written.
//
// probe-jobanalysis.js is hard-wired to ALX_JobAnalysis and its $select. This one takes the
// inquiry NAME, so a new inquiry can be checked the moment it exists — before any sync, table or
// UI is built against it.
//
// ⚠ WHY THIS EXISTS. On 2026-09-16 a comment in myobJobAnalysis.js said ALX_JobAnalysis returned
// "one row per project × task × cost code". It does not: probing 6163 gave TWO rows, one per
// package type. I had already told Jed the cost-code work needed no MYOB-side change on the
// strength of that comment. The probe settled it in one run. So: probe first, believe second.
//
// It asks for NO $select, deliberately — the whole point is to see what a new inquiry actually
// returns, including columns nobody thought to ask for. Two columns called CostCode and CostCode_2,
// carrying different values on one row, is exactly the sort of thing a $select would have hidden.
//
//   node probe-inquiry.js <InquiryName>                    first 2 rows, every field
//   node probe-inquiry.js <InquiryName> --job 6163         filtered to one job
//   node probe-inquiry.js <InquiryName> --rows 10          more rows
//   node probe-inquiry.js <InquiryName> --job 6163 --sum BudgetCost
//                                                          ⚠ THE RECONCILIATION CHECK — see below
//
// --sum is the one that matters for cost-code work. A per-code inquiry is only correct if its
// figures SUM to what the per-package inquiry already reports. On 6163 that is BudgetCost
// 151,365.50 for Glazing (Type G) and 323,003.38 for Cladding (Type C). Bars that each look
// reasonable while summing to the wrong total are worse than no bars: they would contradict the
// dials directly above them and neither would say so.
//
// Needs the SAME credentials the nightly sync uses, set in the shell (NOT committed):
//   $env:SUPABASE_URL, $env:SUPABASE_SERVICE_ROLE_KEY, $env:TOKEN_ENC_KEY   (PROD values)
// ⚠ The repo's .env points at DEV, and shell variables take precedence — so set SUPABASE_URL too,
// or this reads dev with prod keys and comes back empty, which looks like "the inquiry is wrong".
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { readOdataCreds, describeCreds } from "./myobOdataCreds.js";
import { readInquiry } from "./myobOdataRead.js";

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const inquiry = argv.find((a) => !a.startsWith("--") && argv.indexOf(a) === 0);
if (!inquiry) {
  console.error('usage: node probe-inquiry.js <InquiryName> [--job 6163] [--col ProjectID] [--filter "<raw OData>"] [--rows 2] [--sum BudgetCost]');
  process.exit(1);
}
const job = flag("job");
const rows = Number(flag("rows", "2")) || 2;
const sumCol = flag("sum");
/* ⚠ THE JOB COLUMN IS NOT ALWAYS CALLED `Project`. ALX_JobTrans and ALX_JobAnalysis(_Detail) use
   `Project`; VelixoReportsPro-CostProjectionDetail uses `ProjectID` — and in
   VelixoReportsPro-CostBudgets `ProjectID` is an INTERNAL id while `ProjectID_2` is the job number,
   which is the reverse of CostProjectionDetail. The `ID` suffix means nothing in this tenant, so
   the column has to be nameable rather than assumed.
     --col ProjectID          filter that column instead of `Project`
     --filter "<raw OData>"   anything more complicated, e.g. startswith(ProjectID,'6163') */
const jobCol = flag("col", "Project");
const rawFilter = flag("filter");

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

console.log(`\nGeneric Inquiry probe — READ ONLY, nothing is written`);
const creds = await readOdataCreds(db, process.env);
const d = describeCreds(creds);
console.log(`  inquiry          : ${inquiry}`);
console.log(`  connecting as    : ${d.user}`);
console.log(`  tenant           : ${d.tenant}`);
if (job) console.log(`  filtered to job  : ${job}`);

let res;
try {
  res = await readInquiry({
    ...creds,
    inquiry,
    filter: rawFilter || (job ? `${jobCol} eq '${String(job).replace(/'/g, "''")}'` : ""),
    maxRows: sumCol ? 100000 : Math.max(rows, 50),
  });
} catch (e) {
  /* Named rather than swallowed: "inquiry not found" and "not exposed via OData" are different
     problems with different fixes, and the message is the only thing that tells them apart. */
  console.error(`\n✗ could not read "${inquiry}"\n  ${(e && e.message) || e}`);
  console.error(`\n  If it says 404 / not found: check the name, and that the inquiry is EXPOSED`);
  console.error(`  VIA ODATA on its Generic Inquiry screen — an inquiry that works in the browser`);
  console.error(`  is invisible over OData until that box is ticked.\n`);
  process.exit(1);
}

const all = res.rows || [];
console.log(`\n${all.length} row(s)${res.complete === false ? " (truncated)" : ""}`);

const line = "─".repeat(78);
for (const r of all.slice(0, rows)) {
  console.log(line);
  const w = Math.max(...Object.keys(r).map((k) => k.length));
  for (const [k, v] of Object.entries(r)) {
    /* RAW VALUE AND TYPE, never a parsed number. The difference between 0, "0.00", "-35,190.85"
       and an absent field is usually the whole question, and every one of them reads as 0 after
       parsing — which is how a formatted string once looked like a genuine zero. */
    console.log(`  ${k.padEnd(w)}  ${JSON.stringify(v)}  ${typeof v}`);
  }
}
if (all.length > rows) console.log(line + `\n  … ${all.length - rows} more row(s) not printed`);

/* ── the reconciliation, which is what makes a cost-code inquiry trustworthy ── */
if (sumCol) {
  const num = (v) => {
    const n = Number(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const by = new Map();
  for (const r of all) {
    const key = `${r.Project ?? r.ProjectID ?? "?"} · Type ${r.Type ?? "?"}`;
    by.set(key, (by.get(key) || 0) + num(r[sumCol]));
  }
  console.log(`\n${line}\n  SUM of ${sumCol}, grouped by Project × Type`);
  console.log(`  Compare these against the per-package inquiry. They must MATCH, or the new`);
  console.log(`  inquiry is double-counting across a join.`);
  for (const [k, v] of [...by].sort()) {
    console.log(`    ${k.padEnd(28)} ${v.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  }
  if (!all.some((r) => sumCol in r)) {
    console.log(`  ⚠ no row has a "${sumCol}" column — check the spelling against the list above`);
  }
}

console.log(`\nNothing was written.\n`);
