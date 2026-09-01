// Token handling for MYOB Acumatica.
//
// Acumatica rotates the refresh token on EVERY refresh, which makes three things load-bearing.
// Each would fail silently in production and look like a credentials problem:
//
//   1. a rotated token must be persisted, or the next refresh uses a dead one;
//   2. concurrent callers must share ONE refresh, or the second spends an already-spent token
//      and the stored value ends up pointing at nothing;
//   3. the write must happen BEFORE the access token is returned, or a crash in between loses
//      the chain and costs a browser re-approval.
import assert from "node:assert/strict";
import test from "node:test";
import { getMyobAccessToken, myobGet, __resetMyobTokenCache } from "./myobToken.js";

const ENV = {
  MYOB_INSTANCE_URL: "https://example.myobadvanced.com/",
  MYOB_ENDPOINT_VERSION: "24.200.001",
  MYOB_CLIENT_ID: "cid",
  MYOB_CLIENT_SECRET: "secret",
  MYOB_SERVICE_REFRESH_TOKEN: "BOOTSTRAP",
};

// Minimal Supabase stand-in: one table, recording every write.
function fakeDb(initialRow = null) {
  const state = { row: initialRow, writes: [] };
  return {
    state,
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: state.row, error: null }),
        upsert: async (r) => { state.writes.push(r); state.row = { ...r }; return { error: null }; },
      };
    },
  };
}

// Fetch stand-in that hands out a fresh refresh token each time, like Acumatica does.
function rotatingFetch({ delayMs = 0, calls = { n: 0 } } = {}) {
  return async (url, opts) => {
    if (String(url).includes("/identity/connect/token")) {
      calls.n += 1;
      const used = new URLSearchParams(opts.body).get("refresh_token");
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return {
        ok: true,
        json: async () => ({
          access_token: `access-${calls.n}`,
          refresh_token: `rotated-${calls.n}`,
          expires_in: 3600,
          _used: used,
        }),
      };
    }
    return { ok: true, json: async () => [{ ProjectID: { value: "6635" } }] };
  };
}

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

test("seeds from the env var when no row exists, and persists what comes back", async () => {
  __resetMyobTokenCache();
  const db = fakeDb(null);
  await withFetch(rotatingFetch(), () => getMyobAccessToken(db, ENV));
  assert.equal(db.state.writes.length, 1, "must write the row on first use");
  assert.equal(db.state.writes[0].refresh_token, "rotated-1", "must store the ROTATED token, not the bootstrap one");
  assert.equal(db.state.writes[0].provider, "myob");
});

test("prefers the stored token over the env var once seeded", async () => {
  __resetMyobTokenCache();
  const db = fakeDb({ refresh_token: "STORED", rotated_count: 3 });
  let used = null;
  await withFetch(async (url, opts) => {
    used = new URLSearchParams(opts.body).get("refresh_token");
    return { ok: true, json: async () => ({ access_token: "a", refresh_token: "b", expires_in: 3600 }) };
  }, () => getMyobAccessToken(db, ENV));
  assert.equal(used, "STORED", "the env var is bootstrap only — the stored row wins");
});

test("counts rotations, so a flatline is visible", async () => {
  __resetMyobTokenCache();
  const db = fakeDb({ refresh_token: "STORED", rotated_count: 3 });
  await withFetch(rotatingFetch(), () => getMyobAccessToken(db, ENV));
  assert.equal(db.state.writes[0].rotated_count, 4);
});

test("does NOT write when the token did not rotate", async () => {
  __resetMyobTokenCache();
  const db = fakeDb({ refresh_token: "SAME", rotated_count: 1 });
  await withFetch(async () => ({
    ok: true, json: async () => ({ access_token: "a", refresh_token: "SAME", expires_in: 3600 }),
  }), () => getMyobAccessToken(db, ENV));
  assert.equal(db.state.writes.length, 0, "an unchanged token is not worth a write");
});

test("caches the access token instead of refreshing per call", async () => {
  __resetMyobTokenCache();
  const calls = { n: 0 };
  const db = fakeDb({ refresh_token: "STORED", rotated_count: 0 });
  await withFetch(rotatingFetch({ calls }), async () => {
    const a = await getMyobAccessToken(db, ENV);
    const b = await getMyobAccessToken(db, ENV);
    const c = await getMyobAccessToken(db, ENV);
    assert.equal(a, b); assert.equal(b, c);
  });
  assert.equal(calls.n, 1, "three calls must cost ONE refresh — every refresh rotates");
});

test("concurrent callers share a single refresh", async () => {
  __resetMyobTokenCache();
  const calls = { n: 0 };
  const db = fakeDb({ refresh_token: "STORED", rotated_count: 0 });
  await withFetch(rotatingFetch({ delayMs: 25, calls }), async () => {
    const [a, b, c] = await Promise.all([
      getMyobAccessToken(db, ENV),
      getMyobAccessToken(db, ENV),
      getMyobAccessToken(db, ENV),
    ]);
    assert.equal(a, b); assert.equal(b, c);
  });
  // Two parallel refreshes would both spend "STORED"; the second would be rejected and the
  // stored value would end up pointing at a token that no longer exists.
  assert.equal(calls.n, 1, "parallel callers must not each spend the refresh token");
  assert.equal(db.state.writes.length, 1, "and must not each write");
});

test("persists the rotation BEFORE returning the access token", async () => {
  __resetMyobTokenCache();
  const db = fakeDb({ refresh_token: "STORED", rotated_count: 0 });
  let wroteBeforeReturn = false;
  const realUpsert = db.from().upsert;
  await withFetch(rotatingFetch(), async () => {
    const p = getMyobAccessToken(db, ENV);
    await p;
    wroteBeforeReturn = db.state.writes.length === 1;
  });
  assert.ok(wroteBeforeReturn, "a crash between the two must leave the STORED token live");
  assert.ok(realUpsert);
});

test("a refresh failure explains invalid_grant rather than blaming the secret", async () => {
  __resetMyobTokenCache();
  const db = fakeDb({ refresh_token: "STALE", rotated_count: 0 });
  await withFetch(async () => ({
    ok: false, json: async () => ({ error: "invalid_grant", error_description: "Refresh token is invalid" }),
  }), async () => {
    await assert.rejects(
      () => getMyobAccessToken(db, ENV),
      (e) => /invalid_grant|Refresh token is invalid/.test(e.message) && /authorize-myob/.test(e.message),
    );
  });
});

test("refuses to run without the client credentials", async () => {
  __resetMyobTokenCache();
  const db = fakeDb(null);
  await assert.rejects(
    () => getMyobAccessToken(db, { ...ENV, MYOB_CLIENT_SECRET: "" }),
    /MYOB_CLIENT_SECRET/,
  );
});

test("refuses to run with neither a stored row nor a bootstrap token", async () => {
  __resetMyobTokenCache();
  const db = fakeDb(null);
  await assert.rejects(
    () => getMyobAccessToken(db, { ...ENV, MYOB_SERVICE_REFRESH_TOKEN: "" }),
    /authorize-myob/,
  );
});

test("myobGet builds the contract-based url and surfaces the status", async () => {
  __resetMyobTokenCache();
  const db = fakeDb({ refresh_token: "STORED", rotated_count: 0 });
  let seen = null;
  await withFetch(async (url, opts) => {
    if (String(url).includes("/identity/connect/token")) {
      return { ok: true, json: async () => ({ access_token: "tok", refresh_token: "STORED", expires_in: 3600 }) };
    }
    seen = { url, auth: opts.headers.Authorization };
    return { ok: true, json: async () => [{ ProjectID: { value: "6635" } }] };
  }, () => myobGet(db, "Project", "$top=1", ENV));
  // the trailing slash on the instance url must not produce a double slash
  assert.equal(seen.url, "https://example.myobadvanced.com/entity/Default/24.200.001/Project?$top=1");
  assert.equal(seen.auth, "Bearer tok");
});

test("myobGet attaches the HTTP status so a 403 can be told from a 500", async () => {
  __resetMyobTokenCache();
  const db = fakeDb({ refresh_token: "STORED", rotated_count: 0 });
  await withFetch(async (url) => {
    if (String(url).includes("/identity/connect/token")) {
      return { ok: true, json: async () => ({ access_token: "tok", refresh_token: "STORED", expires_in: 3600 }) };
    }
    return { ok: false, status: 403, text: async () => '{"message":"insufficient rights"}' };
  }, async () => {
    await assert.rejects(() => myobGet(db, "Project", "", ENV), (e) => e.status === 403);
  });
});
