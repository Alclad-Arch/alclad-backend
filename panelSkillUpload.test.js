// A new drafting skill version from the app — panelSkillUpload.js (Jed 2026-11-02).
import assert from "node:assert/strict";
import test from "node:test";
import { parseBundle, uploadSkillVersion } from "./panelSkillUpload.js";

const bundle = (files) => {
  const man = Buffer.from(JSON.stringify(files.map(([name, s]) => ({ name, size: Buffer.byteLength(s) }))));
  const len = Buffer.alloc(4); len.writeUInt32BE(man.length);
  return Buffer.concat([len, man, ...files.map(([, s]) => Buffer.from(s))]);
};

test("a skill folder: its files, by name, caches left out", () => {
  const b = parseBundle(bundle([["alclad-panel-drafting/SKILL.md", "# skill"], ["alclad-panel-drafting/scripts/generator/panelgen.py", "print(1)"], ["alclad-panel-drafting/scripts/__pycache__/x.pyc", "zz"]]));
  assert.equal(b.top, "alclad-panel-drafting");
  assert.deepEqual(b.files.map((f) => f.name), ["alclad-panel-drafting/SKILL.md", "alclad-panel-drafting/scripts/generator/panelgen.py"]);
  assert.equal(b.files[1].bytes.toString(), "print(1)");
});

test("refused: no SKILL.md, two folders, path tricks, damaged bundles", () => {
  assert.throws(() => parseBundle(bundle([["x/readme.md", "a"]])), /No SKILL\.md at the top of "x"/);
  assert.throws(() => parseBundle(bundle([["a/SKILL.md", "a"], ["b/SKILL.md", "b"]])), /ONE skill folder/);
  assert.throws(() => parseBundle(bundle([["a/SKILL.md", "a"], ["a/../../etc/passwd", "b"]])), /Not a usable file name/);
  assert.throws(() => parseBundle(bundle([["/abs/SKILL.md", "a"]])), /Not a usable file name/);
  const ok = bundle([["a/SKILL.md", "abc"]]);
  assert.throws(() => parseBundle(ok.subarray(0, ok.length - 1)), /cut short/);
  assert.throws(() => parseBundle(Buffer.concat([ok, Buffer.from("x")])), /extra bytes/);
  assert.throws(() => parseBundle(Buffer.from([0, 0])), /Nothing was sent/);
});

test("uploaded as a NEW VERSION of the skill, with every file", async () => {
  let got = null;
  const client = { skills: { versions: { create: async (id, body) => { got = { id, n: body.files.length }; return { version: "1762000000" } } } } };
  const b = parseBundle(bundle([["a/SKILL.md", "x"], ["a/b.py", "y"]]));
  const out = await uploadSkillVersion(client, "skill_01FWFhxpQCq4d296yb6ZKCbJ", b.files);
  assert.deepEqual(got, { id: "skill_01FWFhxpQCq4d296yb6ZKCbJ", n: 2 });
  assert.equal(out.version, "1762000000");
});
