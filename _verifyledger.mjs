// READ ONLY — one-off, delete after. Did the transaction detail land, and what does 6163 look like?
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
const url = process.env.SUPABASE_URL;
const ref = (String(url).match(/^https:\/\/([a-z0-9]+)\./) || [])[1] || "?";
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
console.log(`\nsupabase project : ${ref}${ref === "kxxmdjcglkosymcufshb" ? "   ⚠ THIS IS DEV" : ""}`);
const { count, error } = await db.from("myob_ledger_line").select("*", { count: "exact", head: true });
if (error) { console.error(`\n✗ ${error.message}\n`); process.exit(1); }
console.log(`myob_ledger_line : ${count} row(s) stored`);
for (const s of ["bill", "receipt", "labour", "other"]) {
  const { count: n } = await db.from("myob_ledger_line").select("*", { count: "exact", head: true }).eq("source", s);
  console.log(`  ${s.padEnd(8)} ${String(n).padStart(7)}`);
}
const { count: withInv } = await db.from("myob_ledger_line").select("*", { count: "exact", head: true }).not("supplier_inv_nbr", "is", null);
console.log(`  with a supplier invoice number : ${withInv}`);

// 6163 — who the money went to, the same arithmetic the panel does.
const { data } = await db.from("myob_ledger_line")
  .select("source,amount,item_vendor,item_vendor_name,employee,employee_name,supplier_inv_nbr")
  .eq("project_id", "6163");
const by = new Map(); let total = 0, orphan = 0;
for (const l of data || []) {
  const amt = Number(l.amount) || 0; total += amt;
  const key = l.item_vendor || l.employee;
  if (!key) { orphan += amt; continue; }
  const cur = by.get(key) || { name: l.item_vendor_name || l.employee_name || key, kind: l.item_vendor ? 'vendor' : 'employee', amount: 0, lines: 0, inv: new Set() };
  cur.amount += amt; cur.lines += 1; if (l.supplier_inv_nbr) cur.inv.add(l.supplier_inv_nbr);
  by.set(key, cur);
}
console.log(`\n6163 — ${(data || []).length} transaction(s), ${total.toFixed(2)} total\n`);
for (const v of [...by.values()].sort((a, b) => b.amount - a.amount).slice(0, 8)) {
  console.log(`  ${v.name.slice(0, 38).padEnd(40)} ${v.amount.toFixed(2).padStart(12)}  ${String((v.amount / total * 100).toFixed(1)).padStart(5)}%  ${v.lines} line(s)  ${v.kind === 'vendor' ? (v.inv.size ? v.inv.size + ' invoice(s)' : 'received, not yet billed') : 'our own labour'}`);
}
if (orphan) console.log(`  ${'(not attributable)'.padEnd(40)} ${orphan.toFixed(2).padStart(12)}`);
// ⚠ Does the detail add up to the summary it explains?
const { data: act } = await db.from("myob_actuals").select("actual_amount").eq("project_id", "6163");
const summary = (act || []).reduce((n, r) => n + Number(r.actual_amount), 0);
console.log(`\n  detail total ${total.toFixed(2)}  vs  myob_actuals cost ${summary.toFixed(2)}`);
console.log(`  ⚠ these should NOT match: the detail keeps income rows too, the summary splits them out.`);
console.log("");
