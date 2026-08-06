// Encryption at rest for the stored Salesforce tokens.
//
// Kept in its own module so it can be tested without starting the server (importing
// server.js opens a listener and a Supabase client). See tokenCrypto.test.js.
//
// Format: "v1:<iv>:<tag>:<ciphertext>", all base64. AES-256-GCM with a fresh 12-byte IV per
// value. The user id is bound in as additional authenticated data, so a ciphertext copied
// into another user's row fails to decrypt rather than silently handing over the wrong
// person's Salesforce access.
import crypto from "crypto";

export const SEAL_PREFIX = "v1:";
export const isSealed = (v) => typeof v === "string" && v.startsWith(SEAL_PREFIX);

// Accepts 32 bytes as hex or base64. Returns null when unset (plaintext mode); throws on a
// key that is present but the wrong size, so a typo can't masquerade as a working
// encrypted deployment.
export function loadKey(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (buf.length !== 32) {
    throw new Error(`TOKEN_ENC_KEY must decode to 32 bytes (got ${buf.length}). Use 32 random bytes as base64 or hex.`);
  }
  return buf;
}

export function seal(plain, userId, key) {
  if (!key || plain == null) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(String(userId)));
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `${SEAL_PREFIX}${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

// Returns the plaintext, or null if the value is sealed and cannot be opened (wrong key,
// tampered, or moved between users). Never falls back to returning the raw value.
export function unseal(value, userId, key) {
  if (!isSealed(value)) return value;              // legacy plaintext, or nothing to do
  if (!key) return null;
  try {
    const [, iv, tag, ct] = value.split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    d.setAAD(Buffer.from(String(userId)));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
