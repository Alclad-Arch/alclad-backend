// A NEW VERSION OF THE PANEL DRAFTING SKILL, FROM THE APP (Jed 2026-11-02: "cant i update the skill by teaching in
// the app like we can other agents?" → a button on Agents → Skills). The skill is code (≈57 files, ≈12.6 MB), not
// words, so Teach can't change it; until now a new version meant running uploadPanelSkill.js in a terminal with
// the Panel Pipeline key. Now a SUPER ADMIN picks the skill's folder in the browser, the files come here as one
// bundle, and this uploads them with the key Render already holds — the key never reaches a browser.
//
// The bundle (application/octet-stream — the app's JSON parser is capped at 100 kb):
//   4 bytes   big-endian length of the manifest
//   manifest  JSON [{ name: "alclad-panel-drafting/SKILL.md", size }, …] — names as the Skills API wants them
//   bytes     each file's bytes, in manifest order
import { toFile } from "@anthropic-ai/sdk";

export const SKILL_LIMIT = 30 * 1024 * 1024;   // the Skills API's own limit
const SKIP = /(^|\/)(__pycache__|\.git|\.DS_Store)(\/|$)|\.pyc$/;

/* Bundle → [{ name, bytes }], checked: one top folder holding SKILL.md, no path tricks, sizes that add up, under
   the limit. Throws with a plain reason. Caches (__pycache__, .pyc) are dropped, as the script drops them. */
export function parseBundle(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) throw new Error("Nothing was sent.");
  const mlen = buf.readUInt32BE(0);
  if (mlen <= 2 || 4 + mlen > buf.length) throw new Error("The upload is damaged (manifest).");
  let manifest;
  try { manifest = JSON.parse(buf.subarray(4, 4 + mlen).toString("utf8")); } catch { throw new Error("The upload is damaged (manifest isn't JSON)."); }
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("No files in the upload.");
  let at = 4 + mlen, top = null;
  const files = [];
  for (const m of manifest) {
    const name = String((m && m.name) || ""), size = Number(m && m.size);
    if (!Number.isInteger(size) || size < 0) throw new Error(`Bad size for ${name || "a file"}.`);
    if (!/^[A-Za-z0-9._ -]+(\/[A-Za-z0-9._ ()-]+)+$/.test(name) || name.split("/").some((p) => p === "." || p === ".."))
      throw new Error(`Not a usable file name: ${name}`);
    const t = name.split("/")[0];
    if (top === null) top = t; else if (t !== top) throw new Error("Pick the ONE skill folder (the one holding SKILL.md), not several.");
    if (at + size > buf.length) throw new Error("The upload is damaged (files cut short).");
    if (!SKIP.test(name)) files.push({ name, bytes: buf.subarray(at, at + size) });
    at += size;
  }
  if (at !== buf.length) throw new Error("The upload is damaged (extra bytes).");
  if (!files.some((f) => f.name === `${top}/SKILL.md`)) throw new Error(`No SKILL.md at the top of "${top}" — pick the folder that holds it.`);
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > SKILL_LIMIT) throw new Error(`${(total / 1048576).toFixed(1)} MB is over the 30 MB limit.`);
  return { top, files, total };
}

/* Upload them as a new version of skillId. client = new Anthropic() (ANTHROPIC_API_KEY on Render). */
export async function uploadSkillVersion(client, skillId, files) {
  const uploads = await Promise.all(files.map((f) => toFile(f.bytes, f.name)));
  const v = await client.skills.versions.create(skillId, { files: uploads });
  return { version: (v && (v.version || v.id)) || null }
}
