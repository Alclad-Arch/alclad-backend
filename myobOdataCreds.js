// The MYOB OData credential: where it lives, and why it lives there.
//
// This surface uses BASIC auth as a named user (the tenant's own WWW-Authenticate says so), which
// means a stored password rather than a rotating token. Two decisions follow.
//
// IT IS DATA, NOT CONFIGURATION. Jed, 2026-09-10: build under Nathan's login and switch to a
// dedicated integration user if it becomes an issue. That is only cheap if nothing in the code
// knows whose login it is — so the username lives in the row alongside the password, and swapping
// user is an UPDATE, not a deploy. The Salesforce grant taught this the hard way: it was wired to
// one person and died silently when their token went.
//
// IT REUSES integration_tokens. The password goes in the `refresh_token` column — the name is a
// misnomer here, and a new table for one row would be worse. `meta` carries the instance, tenant
// and username, none of which are secret, and all of which a health panel needs in order to say
// WHO the app is connecting as. Sealed with the same AES-GCM helper as the Salesforce and MYOB
// OAuth rows, so encryption at rest is one setting for all of them.
import { seal, unseal, isSealed, loadKey } from "./tokenCrypto.js";

export const ODATA_PROVIDER = "myob_odata";
/* The AAD the seal is bound to. Distinct from the OAuth row's, so a value cannot be moved between
   providers and still open — which is the point of authenticating the associated data at all. */
const SEAL_ID = "myob-odata-service";

export function odataConfig(env = process.env) {
  return {
    instance: (env.MYOB_INSTANCE_URL || "").replace(/\/+$/, ""),
    tenant: env.MYOB_TENANT || "",
    user: env.MYOB_ODATA_USER || "",
    pass: env.MYOB_ODATA_PASS || "",
    encKey: loadKey(env.TOKEN_ENC_KEY),
  };
}

/* Read the stored credential, seeding from the environment the first time.
 *
 * Seeding matters for the very first run on a machine that has the values in its shell and nothing
 * in the database yet — the same pattern the OAuth row uses. After that the row is the truth, so
 * changing the env var does NOT silently change who the app connects as. */
export async function readOdataCreds(db, env = process.env) {
  const cfg = odataConfig(env);
  const { data, error } = await db
    .from("integration_tokens")
    .select("refresh_token, meta")
    .eq("provider", ODATA_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(`integration_tokens read failed: ${error.message}`);

  if (data && data.refresh_token) {
    const stored = data.refresh_token;
    /* A row written before TOKEN_ENC_KEY was set is plaintext; unseal only what is sealed, so
       turning encryption on later does not strand the row. */
    const pass = isSealed(stored) ? unseal(stored, SEAL_ID, cfg.encKey) : stored;
    if (!pass) throw new Error("stored MYOB OData password could not be decrypted — TOKEN_ENC_KEY may have changed");
    const meta = data.meta || {};
    return {
      instance: meta.instance || cfg.instance,
      tenant: meta.tenant || cfg.tenant,
      user: meta.user || cfg.user,
      pass,
      seeded: false,
    };
  }

  if (!cfg.user || !cfg.pass) {
    throw new Error(
      "No MYOB OData credential stored, and MYOB_ODATA_USER / MYOB_ODATA_PASS are unset — run set-myob-odata.js first",
    );
  }
  return { ...cfg, pass: cfg.pass, seeded: true };
}

/* Store it. `updated_by` names this module so a row's origin is readable in the table, and the
   password is sealed when a key is configured. Nothing here ever logs or returns the password. */
export async function writeOdataCreds(db, { instance, tenant, user, pass }, env = process.env) {
  const cfg = odataConfig(env);
  if (!instance || !tenant || !user || !pass) {
    throw new Error("writeOdataCreds needs instance, tenant, user and pass");
  }
  const value = cfg.encKey ? seal(pass, SEAL_ID, cfg.encKey) : pass;
  const { error } = await db.from("integration_tokens").upsert({
    provider: ODATA_PROVIDER,
    refresh_token: value,
    rotated_count: 0,
    /* NOT the password. Everything here is shown in the Integrations health panel, so it must be
       safe to display: which tenant, and which user the app connects as. */
    meta: { instance, tenant, user, auth: "basic", encrypted: !!cfg.encKey },
    updated_at: new Date().toISOString(),
    updated_by: "myobOdataCreds",
  });
  if (error) throw new Error(`integration_tokens write failed: ${error.message}`);
  return { stored: true, encrypted: !!cfg.encKey };
}

/* What a health panel can safely show. Deliberately returns no secret at all — the panel's job is
   to answer "is it working, and as whom", and the Salesforce outage showed that a dead credential
   with nothing on screen is worse than any amount of detail. */
export function describeCreds(creds) {
  if (!creds) return { ok: false, note: "no credential stored" };
  return {
    ok: !!(creds.instance && creds.tenant && creds.user && creds.pass),
    instance: creds.instance || null,
    tenant: creds.tenant || null,
    user: creds.user || null,
    source: creds.seeded ? "environment (not yet stored)" : "the stored row",
  };
}
