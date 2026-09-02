// Access tokens for MYOB Acumatica, with the refresh token held in writable storage.
//
// THE PROBLEM THIS SOLVES. Acumatica ROTATES the refresh token on every refresh — it issues a
// new one and invalidates the one just used. The Salesforce service account keeps its refresh
// token in a Render environment variable, which cannot work here: the first refresh in
// production would kill the env var and the integration would die within the hour, reporting
// what looks like bad credentials rather than a design mistake.
//
// So the token lives in public.integration_tokens, and every rotation is written straight
// back. The env var is BOOTSTRAP ONLY — used once to seed the row, then ignored.
//
// Three things this gets right that a naive refresh-per-request would not:
//
//   1. The access token is cached in memory for its lifetime. Refreshing on every request
//      would rotate the refresh token on every request — pointless churn, and every rotation
//      is a chance to lose the chain.
//   2. Concurrent callers share ONE refresh. Two simultaneous refreshes both spend the same
//      refresh token; the second gets invalid_grant and the stored value is left pointing at
//      a token that no longer exists. A single-flight promise makes that impossible.
//   3. The new refresh token is persisted BEFORE the access token is handed out. If the
//      process dies between the two, the stored token is still the live one — losing an
//      access token costs a refresh, losing the refresh token costs a browser re-approval.
import { seal, unseal, isSealed, loadKey } from "./tokenCrypto.js";

const PROVIDER = "myob";
// The AAD the token is sealed under. tokenCrypto binds an identifier into the ciphertext so a
// value copied into another row fails to decrypt; there is no user here, so the provider name
// plays that part.
const SEAL_ID = "myob:service";

const TOKEN_PATH = "/identity/connect/token";
// Refresh this many ms before the access token actually expires, so a request that starts
// just under the wire does not arrive with a token that died in flight.
const EXPIRY_MARGIN_MS = 60_000;

let cached = null;        // { accessToken, expiresAt }
let lastGrantedScope = null;   // what the token actually carries, for diagnostics
let inFlight = null;      // shared promise while a refresh is running

const trimUrl = (u) => String(u || "").replace(/\/+$/, "");

export function myobConfig(env = process.env) {
  return {
    instance: trimUrl(env.MYOB_INSTANCE_URL),
    version: env.MYOB_ENDPOINT_VERSION || "24.200.001",
    clientId: env.MYOB_CLIENT_ID || "",
    clientSecret: env.MYOB_CLIENT_SECRET || "",
    bootstrapRefresh: env.MYOB_SERVICE_REFRESH_TOKEN || "",
    encKey: loadKey(env.TOKEN_ENC_KEY),
  };
}

// Read the stored refresh token, seeding the row from the env var the first time.
async function readRefresh(db, cfg) {
  const { data, error } = await db
    .from("integration_tokens")
    .select("refresh_token, rotated_count")
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) throw new Error(`integration_tokens read failed: ${error.message}`);

  if (data && data.refresh_token) {
    const stored = data.refresh_token;
    // A row written before TOKEN_ENC_KEY was set is plaintext; unseal only what is sealed, so
    // turning encryption on later does not strand the existing row.
    const plain = isSealed(stored) ? unseal(stored, SEAL_ID, cfg.encKey) : stored;
    if (!plain) throw new Error("stored refresh token could not be decrypted — TOKEN_ENC_KEY may have changed");
    return { refresh: plain, rotations: data.rotated_count || 0, seeded: false };
  }

  if (!cfg.bootstrapRefresh) {
    throw new Error(
      "No refresh token stored and MYOB_SERVICE_REFRESH_TOKEN is unset — run authorize-myob.js first",
    );
  }
  return { refresh: cfg.bootstrapRefresh, rotations: 0, seeded: true };
}

async function writeRefresh(db, cfg, refresh, rotations, note) {
  const value = cfg.encKey ? seal(refresh, SEAL_ID, cfg.encKey) : refresh;
  const { error } = await db.from("integration_tokens").upsert({
    provider: PROVIDER,
    refresh_token: value,
    rotated_count: rotations,
    meta: { instance: cfg.instance, version: cfg.version, note },
    updated_at: new Date().toISOString(),
    updated_by: "myobToken",
  });
  if (error) throw new Error(`integration_tokens write failed: ${error.message}`);
}

async function refreshNow(db, cfg) {
  const { refresh, rotations, seeded } = await readRefresh(db, cfg);

  const res = await fetch(`${cfg.instance}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok || !body.access_token) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    // invalid_grant after a rotation almost always means a refresh was lost — say so, because
    // the generic message sends people looking at the client secret instead.
    throw new Error(
      `MYOB token refresh failed: ${detail}` +
        (String(body.error || "").includes("invalid_grant")
          ? " — the stored refresh token is no longer valid. Re-run authorize-myob.js."
          : ""),
    );
  }

  // Persist a rotated token BEFORE returning the access token. Order matters: if this process
  // dies immediately after, the stored value must be the live one.
  const rotated = body.refresh_token && body.refresh_token !== refresh;
  if (rotated || seeded) {
    await writeRefresh(
      db,
      cfg,
      body.refresh_token || refresh,
      rotations + (rotated ? 1 : 0),
      seeded ? "seeded from MYOB_SERVICE_REFRESH_TOKEN" : "rotated on refresh",
    );
  }

  const ttl = Number(body.expires_in || 3600) * 1000;
  // The GRANTED scope, which is not necessarily the scope that was requested. Acumatica can
  // issue a token carrying fewer scopes than asked for — authentication then succeeds while
  // every API call returns 403 "insufficient rights", which looks like a permissions problem
  // on the target screen and is not. Kept so a caller can report it.
  lastGrantedScope = body.scope || "(none reported)";
  cached = { accessToken: body.access_token, expiresAt: Date.now() + ttl - EXPIRY_MARGIN_MS };
  return cached.accessToken;
}

// The only function callers need. Returns a valid access token, refreshing at most once even
// under concurrent callers.
export async function getMyobAccessToken(db, env = process.env) {
  const cfg = myobConfig(env);
  if (!cfg.instance || !cfg.clientId || !cfg.clientSecret) {
    throw new Error("MYOB_INSTANCE_URL, MYOB_CLIENT_ID and MYOB_CLIENT_SECRET must all be set");
  }
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;
  if (inFlight) return inFlight;                       // a refresh is already running — join it

  inFlight = refreshNow(db, cfg).finally(() => { inFlight = null; });
  return inFlight;
}

// A GET against the contract-based endpoint, with the token handled for you.
// Read-only by design: this module offers no way to write to Acumatica.
export async function myobGet(db, entity, query = "", env = process.env) {
  const cfg = myobConfig(env);
  const token = await getMyobAccessToken(db, env);
  const url = `${cfg.instance}/entity/Default/${cfg.version}/${entity}${query ? `?${query}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    const err = new Error(`MYOB ${entity} ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// What the last issued token actually carried. Null until a refresh has run.
export const lastScope = () => lastGrantedScope;

// Testing seam — the in-memory cache would otherwise leak between cases.
export function __resetMyobTokenCache() { cached = null; inFlight = null; lastGrantedScope = null; }
