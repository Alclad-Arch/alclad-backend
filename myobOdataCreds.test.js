// Where the MYOB OData credential lives.
//
// Basic auth means a stored PASSWORD rather than a rotating token, so the failure modes are
// different from the OAuth row's — and every one of these is silent:
//
//   · the password reaching `meta`, which the Integrations health panel displays;
//   · the row being ignored in favour of an env var, so "switch the user" appears to work and
//     doesn't (the whole point of storing the username as data);
//   · a seal that opens under the wrong AAD, which would let a value be moved between providers;
//   · describeCreds leaking the secret into a panel built to show status.
import assert from "node:assert/strict";
import test from "node:test";
import { readOdataCreds, writeOdataCreds, describeCreds, ODATA_PROVIDER } from "./myobOdataCreds.js";
import { isSealed } from "./tokenCrypto.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const LIVE = {
  instance: "https://alcladarchitectural.myobadvanced.com",
  tenant: "Alclad Architectural Live",
  user: "nathan@alcladaus.com.au",
  pass: "s3cret-p455",
};

/* A fake Supabase: one table, recording what was written. */
const fakeDb = (initial = null) => {
  const state = { row: initial, writes: [] };
  return {
    state,
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: state.row, error: null }; },
        async upsert(row) { state.writes.push(row); state.row = row; return { error: null }; },
      };
    },
  };
};

test("the password is SEALED in the row when a key is set", async () => {
  const db = fakeDb();
  await writeOdataCreds(db, LIVE, { TOKEN_ENC_KEY: KEY });
  const row = db.state.writes[0];
  assert.ok(isSealed(row.refresh_token), row.refresh_token);
  assert.ok(!row.refresh_token.includes(LIVE.pass), "the plaintext must not survive anywhere in the value");
});

test("…and the password is NOWHERE in meta", async () => {
  /* meta is what the Integrations health panel renders. A password there would be on a screen. */
  const db = fakeDb();
  await writeOdataCreds(db, LIVE, { TOKEN_ENC_KEY: KEY });
  const meta = JSON.stringify(db.state.writes[0].meta);
  assert.ok(!meta.includes(LIVE.pass), meta);
  assert.match(meta, /nathan@alcladaus\.com\.au/, "the USERNAME does belong there — the panel has to say who we connect as");
  assert.match(meta, /Alclad Architectural Live/);
});

test("it is filed under its own provider, not the OAuth row's", async () => {
  const db = fakeDb();
  await writeOdataCreds(db, LIVE, { TOKEN_ENC_KEY: KEY });
  assert.equal(db.state.writes[0].provider, ODATA_PROVIDER);
  assert.notEqual(ODATA_PROVIDER, "myob");
});

test("a round trip returns the password and nothing is left sealed to the caller", async () => {
  const db = fakeDb();
  await writeOdataCreds(db, LIVE, { TOKEN_ENC_KEY: KEY });
  const got = await readOdataCreds(db, { TOKEN_ENC_KEY: KEY });
  assert.equal(got.pass, LIVE.pass);
  assert.equal(got.user, LIVE.user);
  assert.equal(got.tenant, LIVE.tenant);
  assert.equal(got.seeded, false);
});

test("THE ROW WINS over the environment — that is what makes switching user real", async () => {
  /* Jed's plan is to run under Nathan's login and swap to a dedicated user later. If the env var
     could override the row, that swap would appear to work while the app carried on as before. */
  const db = fakeDb();
  await writeOdataCreds(db, { ...LIVE, user: "integration@alcladaus.com.au" }, { TOKEN_ENC_KEY: KEY });
  const got = await readOdataCreds(db, {
    TOKEN_ENC_KEY: KEY,
    MYOB_ODATA_USER: "nathan@alcladaus.com.au",
    MYOB_TENANT: "Some Other Tenant",
  });
  assert.equal(got.user, "integration@alcladaus.com.au");
  assert.equal(got.tenant, LIVE.tenant);
});

test("with no row, it seeds from the environment and SAYS so", async () => {
  const got = await readOdataCreds(fakeDb(), {
    MYOB_INSTANCE_URL: LIVE.instance, MYOB_TENANT: LIVE.tenant,
    MYOB_ODATA_USER: LIVE.user, MYOB_ODATA_PASS: LIVE.pass,
  });
  assert.equal(got.pass, LIVE.pass);
  assert.equal(got.seeded, true, "a seeded credential is not yet durable, and the panel should say that");
});

test("with neither a row nor an environment, it says what to run", async () => {
  await assert.rejects(() => readOdataCreds(fakeDb(), {}), /set-myob-odata\.js/);
});

test("a wrong key does not fall back to returning the sealed value", async () => {
  /* Returning the ciphertext as a password would send gibberish to MYOB and read as a rejected
     credential, sending someone to reset a password that was fine. */
  const db = fakeDb();
  await writeOdataCreds(db, LIVE, { TOKEN_ENC_KEY: KEY });
  await assert.rejects(
    () => readOdataCreds(db, { TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString("base64") }),
    /could not be decrypted/);
});

test("a plaintext row from before encryption was turned on still opens", async () => {
  /* Otherwise enabling TOKEN_ENC_KEY later strands the existing credential. */
  const db = fakeDb({ refresh_token: "legacy-plain", meta: { user: "u", tenant: "t", instance: "i" } });
  const got = await readOdataCreds(db, { TOKEN_ENC_KEY: KEY });
  assert.equal(got.pass, "legacy-plain");
});

test("writing a half-filled credential is refused", async () => {
  await assert.rejects(() => writeOdataCreds(fakeDb(), { ...LIVE, pass: "" }, {}), /needs instance, tenant, user and pass/);
  await assert.rejects(() => writeOdataCreds(fakeDb(), { ...LIVE, tenant: "" }, {}), /needs instance, tenant, user and pass/);
});

test("describeCreds says who and whence, and never the secret", async () => {
  const d = describeCreds({ ...LIVE, seeded: false });
  assert.equal(d.ok, true);
  assert.equal(d.user, LIVE.user);
  assert.equal(d.source, "the stored row");
  assert.ok(!JSON.stringify(d).includes(LIVE.pass), JSON.stringify(d));
});

test("…and reports a missing credential as not-ok rather than throwing", () => {
  /* A health panel that throws shows nothing, which is the failure it exists to prevent. */
  assert.equal(describeCreds(null).ok, false);
  assert.equal(describeCreds({ instance: "i", tenant: "t", user: "u" }).ok, false, "no password is not ok");
});
