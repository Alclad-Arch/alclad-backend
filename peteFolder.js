// PETE LOOKS IN THE JOB'S FOLDER ON G (Jed 2026-11-16: Claude Desktop works "on your computer" - it checks Claude DXFs
// after saving, spots old versions, reads what's there; the first thing to give the rebuilt Pete back). READ-ONLY:
// he never deletes, moves or edits anything on G - that stays with the person.
//
// What he reads is the app's own index of the job's G folder, kept by the file-server connector (alclad.app
// project_folders / project_files / project_file_chunks, 20261031_gdrive_index.sql - refreshed every couple of
// minutes; .bak/.tmp files are not indexed), and the log of what the connector wrote for his saved files
// (panel_file_syncs, 20261101_panel_gsync.sql). Pure helpers + the three tools, run by peteWorker.js.

export const G_SUB = {
  claude_dxfs: "7. Drawings\\7. Cladding\\1. Fab Drawings\\Claude DXFs",
  layout_drawings: "7. Drawings\\7. Cladding\\4. Layout Drawings",
  fab_drawings: "7. Drawings\\7. Cladding\\1. Fab Drawings",
  cladding: "7. Drawings\\7. Cladding",
};

export const FOLDER_TOOLS = [
  {
    name: "look_in_job_folder",
    description: "List the files in this job's folder on G (read-only), newest first: path, size, when last changed, and whether it's an old superseded copy. folder: claude_dxfs (your saved drawings and production files), layout_drawings (PDFs), fab_drawings, cladding (all of 7. Cladding), or all. search narrows it to paths containing every word. Use it to check what's there before and after saving, spot old versions, and find measure sheets or drawings. The list is the app's index of G, refreshed every couple of minutes - a file saved this minute may not show yet. .bak files are not listed.",
    input_schema: { type: "object", properties: {
      folder: { type: "string", enum: ["claude_dxfs", "layout_drawings", "fab_drawings", "cladding", "all"] },
      search: { type: "string", description: "Words that must all be in the path, e.g. \"OF2 machining\". Optional." } }, required: ["folder"] },
  },
  {
    name: "read_job_document",
    description: "The text of one PDF, Word or Excel file in the job's folder on G (read-only), page by page - a schedule, a spec, a measure sheet's typed text, an email. path as look_in_job_folder gives it. DXF/DWG drawings and photos have no text here (look at them by asking for a screenshot).",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "check_files_on_g",
    description: "Did the files you saved in this chat reach the job's folder on G? For each: written (and when), kept beside a hand-edited copy (G had a version someone changed by hand, so yours went next to it as \"<name> (app).ext\" - tell them, and ask which to keep), failed (and why), or not yet (the file server copies new files every couple of minutes). Use it after saving, before you tell them the files are in Claude DXFs.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];
export const FOLDER_TOOL_NAMES = FOLDER_TOOLS.map((t) => t.name);

const norm = (p) => String(p || "").replace(/\//g, "\\").replace(/\\+$/, "");
const lower = (p) => norm(p).toLowerCase();

/* A file's path as Pete sees it: from the job's own folder (…\Projects\<job>\) when the linked folder is inside one,
   so "7. Drawings\7. Cladding\…" reads the same however the hub linked it; else from the linked folder. */
export function jobPath(gPath, relPath) {
  const full = `${norm(gPath)}\\${norm(relPath)}`;
  const m = /^(.*?\\Projects\\[^\\]+)\\(.*)$/i.exec(full);
  return m ? m[2] : norm(relPath);
}

// the rows that match a folder choice and search words, newest first
export function pickFiles(rows, { folder = "all", search = "" } = {}) {
  const sub = G_SUB[folder] ? lower(G_SUB[folder]) + "\\" : "";
  const words = String(search || "").toLowerCase().split(/\s+/).filter(Boolean);
  return (rows || [])
    .map((r) => ({ ...r, path: jobPath(r.g_path, r.rel_path) }))
    .filter((r) => (!sub || lower(r.path).startsWith(sub)) && words.every((w) => lower(r.path).includes(w)))
    .sort((a, b) => String(b.modified_at || "").localeCompare(String(a.modified_at || "")));
}

const when = (t) => { const d = t ? new Date(t) : null; return d && !isNaN(d) ? d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Australia/Melbourne" }) : "?"; };
const kb = (n) => (n == null ? "?" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function listingText(files, { folder, search, limit = 150 } = {}) {
  if (!files.length) return `Nothing in ${folder === "all" ? "the job's folder" : G_SUB[folder] || folder}${search ? ` matching "${search}"` : ""} (as of the last index - a file saved in the last couple of minutes may not show yet).`;
  const lines = files.slice(0, limit).map((f) => `${f.path} | ${kb(f.size_bytes)} | changed ${when(f.modified_at)}${f.superseded ? " | superseded copy" : ""}`);
  return `${files.length} file${files.length === 1 ? "" : "s"}${files.length > limit ? ` (newest ${limit} shown)` : ""}, newest first:\n` + lines.join("\n");
}

export function syncText(saved, syncs) {
  if (!saved.length) return "You haven't saved any files in this chat yet.";
  const by = new Map((syncs || []).map((s) => [s.file_id, s]));
  return saved.map((f) => {
    const s = by.get(f.id);
    if (!s) return `${f.name}: not on G yet - the file server copies new files every couple of minutes.`;
    if (s.status === "synced") return `${f.name}: written to G ${when(s.synced_at)} (${s.g_path}).`;
    if (s.status === "kept_hand_edit") return `${f.name}: G had a HAND-EDITED copy, so it was kept and yours saved beside it as ${s.note || "(app) copy"} - tell them and ask which to keep.`;
    return `${f.name}: NOT written - ${s.note || "error"}${s.attempts >= 20 ? " (gave up after 20 tries)" : " (the file server tries again)"}.`;
  }).join("\n");
}

/* The tools, run as the worker (service role) but only ever on THIS chat's job: its hub project's linked folders, its
   own saved files. Returns the text for the tool_result. */
export async function runFolderTool(db, { job, chatId }, name, input = {}) {
  const folders = async () => {
    if (!job.pm_project_id) return { none: "This panel job isn't linked to a hub project, so there's no G folder to look in - ask them to link it (Project details)." };
    const { data, error } = await db.from("project_folders").select("id, g_path, status, last_sync_at").eq("pm_project_id", job.pm_project_id);
    if (error) throw new Error("reading the job's folders: " + error.message);
    if (!data || !data.length) return { none: "The job's hub project has no G folder linked yet, so there's nothing to look in - ask them to link it (Project details)." };
    return { list: data };
  };
  if (name === "look_in_job_folder") {
    const f = await folders(); if (f.none) return f.none;
    const { data, error } = await db.from("project_files").select("folder_id, rel_path, name, size_bytes, modified_at, superseded").in("folder_id", f.list.map((x) => x.id)).limit(5000);
    if (error) throw new Error("reading the folder index: " + error.message);
    const gp = new Map(f.list.map((x) => [x.id, x.g_path]));
    const rows = (data || []).map((r) => ({ ...r, g_path: gp.get(r.folder_id) }));
    const synced = f.list.map((x) => x.last_sync_at).filter(Boolean).sort().pop();
    return listingText(pickFiles(rows, input), input) + (synced ? `\n(index last refreshed ${when(synced)})` : "");
  }
  if (name === "read_job_document") {
    const f = await folders(); if (f.none) return f.none;
    const want = lower(input.path);
    const { data: files, error } = await db.from("project_files").select("id, folder_id, rel_path, text_status").in("folder_id", f.list.map((x) => x.id)).limit(5000);
    if (error) throw new Error("reading the folder index: " + error.message);
    const gp = new Map(f.list.map((x) => [x.id, x.g_path]));
    const hit = (files || []).find((r) => lower(jobPath(gp.get(r.folder_id), r.rel_path)) === want) || (files || []).find((r) => lower(r.rel_path) === want);
    if (!hit) return `No file at "${input.path}" in the job's folder index - use look_in_job_folder for the exact path.`;
    if (hit.text_status !== "ok") return `${input.path} has no text in the index (${hit.text_status === "skipped" ? "a drawing or photo" : hit.text_status}). Ask them for a screenshot if you need to see it.`;
    const { data: ch } = await db.from("project_file_chunks").select("page, chunk, body").eq("file_id", hit.id).order("page").order("chunk").limit(200);
    let out = "", n = 0;
    for (const c of ch || []) { const add = `${c.page != null ? `[page ${c.page}] ` : ""}${c.body}\n`; if (n + add.length > 40000) { out += "…(cut - the rest is longer than fits)"; break; } out += add; n += add.length; }
    return out.trim() || `${input.path}: no text came out of it.`;
  }
  if (name === "check_files_on_g") {
    const { data: saved } = await db.from("panel_files").select("id, name, created_at").eq("chat_id", chatId).eq("kind", "chat_output").order("created_at", { ascending: false }).limit(60);
    const ids = (saved || []).map((s) => s.id);
    const { data: syncs } = ids.length ? await db.from("panel_file_syncs").select("file_id, status, g_path, note, attempts, synced_at").in("file_id", ids) : { data: [] };
    // only the latest copy of each name counts (an earlier turn's version was replaced by the later one)
    const latest = []; const seen = new Set();
    for (const s of saved || []) { const k = s.name.toLowerCase(); if (!seen.has(k)) { seen.add(k); latest.push(s); } }
    return syncText(latest, syncs || []);
  }
  return null;
}
