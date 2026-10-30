// Upload the alclad-panel-drafting skill to the Anthropic workspace, so the panel worker can use it.
// (app-contract.md §1, "Set-up (once)"). Run on a PC that has the skill folder — it isn't in this repo:
//
//   node uploadPanelSkill.js <path to the alclad-panel-drafting folder>              first time: prints the skill id
//   node uploadPanelSkill.js <path to the alclad-panel-drafting folder> <skill_id>   a new version of it
//
// ANTHROPIC_API_KEY must be set in the shell (the same key as Render's). Then set PANEL_SKILL_ID=<id> on
// Render. Every file under the folder goes up with its path, under the folder's own name, which is what
// the Skills API asks for (one top-level directory with SKILL.md at its root). Compiled Python caches are
// left out; the whole thing must stay under 30 MB.
import fs from "fs";
import path from "path";
import Anthropic, { toFile } from "@anthropic-ai/sdk";

const SKIP = /(^|[\\/])(__pycache__|\.git|\.DS_Store)([\\/]|$)|\.pyc$/;
const LIMIT = 30 * 1024 * 1024;

export function skillFiles(dir) {
  const root = path.resolve(dir), top = path.basename(root), out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name), rel = path.relative(root, full);
      if (SKIP.test(rel)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push({ full, name: top + "/" + rel.split(path.sep).join("/"), size: fs.statSync(full).size });
    }
  };
  walk(root);
  return out;
}

async function main() {
  const [dir, skillId] = process.argv.slice(2);
  if (!dir) { console.error("Usage: node uploadPanelSkill.js <alclad-panel-drafting folder> [skill_id]"); process.exit(2); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error("Set ANTHROPIC_API_KEY in this shell first."); process.exit(2); }
  const files = skillFiles(dir);
  if (!files.some((f) => /^[^/]+\/SKILL\.md$/.test(f.name))) { console.error(`No SKILL.md at the top of ${dir} — point at the folder that holds it.`); process.exit(2); }
  const total = files.reduce((n, f) => n + f.size, 0);
  console.log(`${files.length} files, ${(total / 1048576).toFixed(1)} MB`);
  if (total > LIMIT) { console.error("Over the 30 MB limit."); process.exit(2); }
  const uploads = await Promise.all(files.map((f) => toFile(fs.readFileSync(f.full), f.name)));
  const client = new Anthropic();
  if (skillId) {
    const v = await client.skills.versions.create(skillId, { files: uploads });
    console.log(`New version of ${skillId}: ${v.version || v.id || JSON.stringify(v)}`);
    console.log("The worker uses version \"latest\", so it picks this up on its next run.");
  } else {
    const s = await client.skills.create({ files: uploads, display_name: "Alclad panel drafting" });
    console.log(`Skill created: ${s.id}`);
    console.log(`Now set PANEL_SKILL_ID=${s.id} on Render (alclad-backend → Environment).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main().catch((e) => { console.error("Upload failed:", (e && e.message) || e); process.exit(1); });
}
