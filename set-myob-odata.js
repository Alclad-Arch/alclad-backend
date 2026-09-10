// Store the MYOB OData credential once, so nothing afterwards needs it in an environment.
//
//   $env:MYOB_INSTANCE_URL = "https://alcladarchitectural.myobadvanced.com"
//   $env:MYOB_TENANT       = "Alclad Architectural Live"
//   $env:MYOB_ODATA_USER   = "<the user>"
//   $env:MYOB_ODATA_PASS   = "<its password>"
//   node set-myob-odata.js
//
// WHY A ROW AND NOT AN ENV VAR. Jed, 2026-09-10: build under Nathan's login and swap to a
// dedicated integration user if it becomes an issue. That swap is only cheap if the username is
// DATA — so it goes in the row, and switching later is this script again with different values,
// not a deploy. It also means the app never has the password in its environment, and the
// Integrations panel can say who it connects as.
//
// The password is sealed with TOKEN_ENC_KEY when that is set, the same as the Salesforce and MYOB
// OAuth rows. It is never printed here, on success or on failure.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { odataConfig, writeOdataCreds, readOdataCreds, describeCreds } from "./myobOdataCreds.js";

const need = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MYOB_INSTANCE_URL", "MYOB_TENANT",
  "MYOB_ODATA_USER", "MYOB_ODATA_PASS"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\nMissing: ${missing.join(", ")}`);
  console.error("Set them in this shell (or .env) and re-run.\n");
  process.exit(1);
}

/* WHICH DATABASE. authorize-service.js learned this the hard way: this repo's .env points at DEV,
   so a credential stored here without looking lands on the wrong project and the live sync still
   has nothing. Say it out loud before writing. */
const ref = (String(process.env.SUPABASE_URL).match(/^https:\/\/([a-z0-9]+)\./) || [])[1] || "?";
const cfg = odataConfig();
console.log(`\nStoring the MYOB OData credential`);
console.log(`  supabase project : ${ref}   ← check this is the one you mean`);
console.log(`  instance         : ${cfg.instance}`);
console.log(`  tenant           : ${cfg.tenant}`);
console.log(`  user             : ${cfg.user}`);
console.log(`  at rest          : ${cfg.encKey ? "encrypted (TOKEN_ENC_KEY set)" : "PLAINTEXT — set TOKEN_ENC_KEY to seal it"}`);

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

try {
  const res = await writeOdataCreds(db, {
    instance: cfg.instance, tenant: cfg.tenant, user: cfg.user, pass: cfg.pass,
  });
  /* Read it back through the same path the sync uses. Writing and then not checking is how the
     Salesforce token came to be stored where nothing read it. */
  const back = await readOdataCreds(db, process.env);
  const d = describeCreds(back);
  console.log(`\nStored${res.encrypted ? " and sealed" : " in plaintext"}.`);
  console.log(`Read back: ${d.ok ? "OK" : "INCOMPLETE"} · as ${d.user} · tenant ${d.tenant} · from ${d.source}`);
  if (back.pass !== cfg.pass) {
    console.error("\n⚠ the password read back does not match what was written — do not rely on this row.\n");
    process.exit(1);
  }
  console.log("\nNext: node sync-myob-actuals.js\n");
} catch (e) {
  console.error(`\nFailed: ${(e && e.message) || e}\n`);
  process.exit(1);
}
