// Pete looks in the job's folder on G (read-only) - peteFolder.js. What matters: paths read from the job's own folder
// however the hub linked it; the folder choices and search words; newest first; a document's text by page; whether his
// saved files reached G (written / kept beside a hand edit / failed / not yet), latest copy of each name only; a job
// with no linked folder says so; and he only ever reads THIS job.
import assert from "node:assert/strict";
import test from "node:test";
import { jobPath, pickFiles, listingText, syncText, runFolderTool, FOLDER_TOOLS, G_SUB } from "./peteFolder.js";

const ROOT = "G:\\Project Delivery\\Projects\\6163 Hale Oakleigh South";

test("paths read from the job's own folder, however the hub linked it", () => {
  assert.equal(jobPath(ROOT, "7. Drawings\\7. Cladding\\1. Fab Drawings\\Claude DXFs\\a.dxf"), "7. Drawings\\7. Cladding\\1. Fab Drawings\\Claude DXFs\\a.dxf");
  assert.equal(jobPath(ROOT + "\\7. Drawings", "7. Cladding\\4. Layout Drawings\\b.pdf"), "7. Drawings\\7. Cladding\\4. Layout Drawings\\b.pdf");
  assert.equal(jobPath("\\\\srv\\share\\misc", "x.pdf"), "x.pdf");
});

const rows = [
  { g_path: ROOT, rel_path: `${G_SUB.claude_dxfs}\\6163 - Set 1 - Machining - Frost White 4000x1250.dxf`, size_bytes: 300000, modified_at: "2026-11-16T01:00:00Z" },
  { g_path: ROOT, rel_path: `${G_SUB.claude_dxfs}\\6163 - OF1 & OF4 Monument - Machining 3200x1250.dxf`, size_bytes: 200000, modified_at: "2026-11-13T01:00:00Z" },
  { g_path: ROOT, rel_path: `${G_SUB.layout_drawings}\\6163 - Set 1 - Panel preview.pdf`, size_bytes: 900000, modified_at: "2026-11-15T01:00:00Z" },
  { g_path: ROOT, rel_path: "3. Site Measure\\OF2 South.pdf", size_bytes: 50000, modified_at: "2026-11-10T01:00:00Z", superseded: true },
];

test("folder choices, search words, newest first", () => {
  assert.deepEqual(pickFiles(rows, { folder: "claude_dxfs" }).map((r) => r.path.split("\\").pop()), ["6163 - Set 1 - Machining - Frost White 4000x1250.dxf", "6163 - OF1 & OF4 Monument - Machining 3200x1250.dxf"]);
  assert.equal(pickFiles(rows, { folder: "layout_drawings" }).length, 1);
  assert.equal(pickFiles(rows, { folder: "cladding" }).length, 3);
  assert.equal(pickFiles(rows, { folder: "all", search: "monument MACHINING" }).length, 1);
  const t = listingText(pickFiles(rows, { folder: "all" }), { folder: "all" });
  assert.match(t, /^4 files, newest first:/); assert.match(t, /OF2 South\.pdf \| 49 KB \| changed .* \| superseded copy/);
  assert.match(listingText([], { folder: "claude_dxfs", search: "x" }), /^Nothing in 7\. Drawings.*Claude DXFs matching "x".*may not show yet/);
});

test("did his saved files reach G", () => {
  const saved = [{ id: "a", name: "P.dxf" }, { id: "b", name: "Main Drawing File.dxf" }, { id: "c", name: "Q.pdf" }, { id: "d", name: "R.dxf" }];
  const t = syncText(saved, [
    { file_id: "a", status: "synced", g_path: "G:\\x\\P.dxf", synced_at: "2026-11-16T01:00:00Z" },
    { file_id: "b", status: "kept_hand_edit", note: "G:\\x\\Main Drawing File (app).dxf" },
    { file_id: "c", status: "error", note: "The file is open or locked on G", attempts: 2 },
  ]).split("\n");
  assert.match(t[0], /^P\.dxf: written to G/);
  assert.match(t[1], /HAND-EDITED copy.*Main Drawing File \(app\)\.dxf.*ask which to keep/);
  assert.match(t[2], /NOT written - The file is open or locked on G \(the file server tries again\)/);
  assert.match(t[3], /^R\.dxf: not on G yet/);
  assert.equal(syncText([], []), "You haven't saved any files in this chat yet.");
});

function db(tables) {
  const calls = [];
  return { calls, from(table) {
    const f = []; let lim = null;
    const api = { select() { return api; }, order() { return api; }, limit(n) { lim = n; return api; },
      eq(k, v) { f.push((r) => r[k] === v); calls.push([table, "eq", k, v]); return api; },
      in(k, vs) { f.push((r) => vs.includes(r[k])); calls.push([table, "in", k, vs]); return api; },
      then(res) { const rows = (tables[table] || []).filter((r) => f.every((fn) => fn(r))); return res({ data: lim ? rows.slice(0, lim) : rows, error: null }); } };
    return api;
  } };
}

test("the tools, on THIS job only", async () => {
  const d = db({
    project_folders: [{ id: "fo1", pm_project_id: "hub_6163", g_path: ROOT, last_sync_at: "2026-11-16T01:02:00Z" }, { id: "fo9", pm_project_id: "hub_other", g_path: "G:\\Project Delivery\\Projects\\9999 Other" }],
    project_files: [...rows.map((r, i) => ({ id: "pf" + i, folder_id: "fo1", ...r, text_status: r.rel_path.endsWith(".pdf") ? "ok" : "skipped" })), { id: "px", folder_id: "fo9", rel_path: `${G_SUB.claude_dxfs}\\SECRET.dxf`, modified_at: "2026-11-16T09:00:00Z" }],
    project_file_chunks: [{ file_id: "pf3", page: 1, chunk: 0, body: "OF2 SOUTH  W 1200  H 2400" }, { file_id: "pf3", page: 2, chunk: 0, body: "P-12 return 50" }],
    panel_files: [{ id: "a", name: "P.dxf", chat_id: "c1", kind: "chat_output", created_at: "2026-11-16T02:00:00Z" }, { id: "a0", name: "P.dxf", chat_id: "c1", kind: "chat_output", created_at: "2026-11-16T01:00:00Z" }, { id: "z", name: "Other.dxf", chat_id: "c2", kind: "chat_output", created_at: "2026-11-16T02:00:00Z" }],
    panel_file_syncs: [{ file_id: "a", status: "synced", g_path: "G:\\x\\P.dxf", synced_at: "2026-11-16T02:03:00Z" }],
  });
  const job = { id: "pj_1", pm_project_id: "hub_6163" };
  const list = await runFolderTool(d, { job, chatId: "c1" }, "look_in_job_folder", { folder: "claude_dxfs" });
  assert.match(list, /^2 files/); assert.doesNotMatch(list, /SECRET/); assert.match(list, /index last refreshed/);
  const doc = await runFolderTool(d, { job, chatId: "c1" }, "read_job_document", { path: "3. Site Measure\\OF2 South.pdf" });
  assert.equal(doc, "[page 1] OF2 SOUTH  W 1200  H 2400\n[page 2] P-12 return 50");
  assert.match(await runFolderTool(d, { job, chatId: "c1" }, "read_job_document", { path: rows[0].rel_path }), /no text in the index \(a drawing or photo\)/);
  assert.match(await runFolderTool(d, { job, chatId: "c1" }, "read_job_document", { path: "nope.pdf" }), /^No file at "nope\.pdf"/);
  const chk = await runFolderTool(d, { job, chatId: "c1" }, "check_files_on_g", {});
  assert.equal(chk.split("\n").length, 1); assert.match(chk, /^P\.dxf: written to G/);           // the latest copy only; never another chat's
  assert.match(await runFolderTool(d, { job: { id: "pj_2", pm_project_id: null }, chatId: "c1" }, "look_in_job_folder", { folder: "all" }), /isn't linked to a hub project/);
  assert.match(await runFolderTool(d, { job: { id: "pj_3", pm_project_id: "hub_none" }, chatId: "c1" }, "look_in_job_folder", { folder: "all" }), /no G folder linked yet/);
  assert.deepEqual(FOLDER_TOOLS.map((t) => t.name), ["look_in_job_folder", "read_job_document", "check_files_on_g"]);
});
