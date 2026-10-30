// uploadPanelSkill.js: which files go up, and under what names (the Skills API wants one top-level folder
// holding SKILL.md).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { skillFiles } from "./uploadPanelSkill.js";

test("every file goes up under the folder's own name, with forward slashes; caches are left out", () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skill-")), "alclad-panel-drafting");
  for (const [p, body] of [["SKILL.md", "---\nname: x\n---"], ["scripts/draft.py", "print(1)"], ["scripts/generator/nest.py", "x"],
    ["scripts/__pycache__/draft.cpython-312.pyc", "c"], ["scripts/old.pyc", "c"]]) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), body);
  }
  const names = skillFiles(root).map((f) => f.name).sort();
  assert.deepEqual(names, ["alclad-panel-drafting/SKILL.md", "alclad-panel-drafting/scripts/draft.py", "alclad-panel-drafting/scripts/generator/nest.py"]);
});
