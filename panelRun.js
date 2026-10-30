// Panel drafting runs — the pure half (no network): what is sent to Claude, and how its answer is read.
// Jed 2026-10-29: cassette panels drafted from site measure sheets by the alclad-panel-drafting skill
// (contract: its references/app-contract.md). The worker (panelWorker.js) does the I/O.
//
// The contract's call, brought up to today's API (checked 2026-10-29): a custom skill loads through
// `container.skills` with the code-execution tool `code_execution_20260521` on the beta path with the
// `code-execution-2025-08-25` flag; the Files API is out of beta. A long run comes back as
// `pause_turn` — the assistant turn is appended and the same request sent again, nothing added.

export const PANEL_MODEL = () => process.env.PANEL_MODEL || "claude-opus-5-5";
export const PANEL_BETAS = ["code-execution-2025-08-25"];
export const CODE_TOOL = { type: "code_execution_20260521", name: "code_execution" };
export const MAX_CALLS = 30;          // pause_turn rounds in one run before it is called stuck
export const LEASE_MS = 10 * 60 * 1000;

// the task text per mode — app-contract.md §4, word for word where it gives one
export function taskText(mode, x = {}) {
  const names = (x.sheetNames || []).join(", ");
  if (mode === "draft") return `New draft. Job: job.json. Sheets attached: ${names}. Draft them with the alclad-panel-drafting skill.`;
  if (mode === "redraw") return `Redraw. Previous reading: reading.json. Answers: answers.json (list of {question, answer}). Draft ${x.draftName || "the job"} rev ${x.rev}. Sheets attached: ${names}.`;
  if (mode === "release") return `Release the approved draft. Spec: spec.json. Set ${x.setNo} "${x.setLabel}", date ${x.date}. Main Drawing File: ${x.mainFile || "none - first set"}. Offcuts: offcuts.json. Ordered layout: ${x.layout ? "layout.json" : "none"}.`;
  if (mode === "recut") return `Recut panels ${(x.ids || []).join(", ")} of set ${x.setNo}: ${x.reason}. Recut ${x.recutNo}. Main Drawing File: ${x.mainFile || "none"}. Offcuts: offcuts.json.`;
  throw new Error("Unknown run mode: " + mode);
}

// job.json — app-contract.md §3, from the panel_jobs row (+ its sets)
/* `batch`: what this batch of sheets says over the job's settings — its sheet view (Jed 2026-10-30: "Sheets
   could potentially come in different orientations for the same job"), chosen at Draft these. */
export function jobJson(job, sets = [], batch = {}) {
  const over = batch && (batch.sheet_view === 'front' || batch.sheet_view === 'rear') ? { sheet_view: batch.sheet_view } : {};
  return {
    settings: { job: job.name, ...(job.settings || {}), ...over },
    settings_confirmed: !!job.settings_confirmed,
    notes: job.notes || [],
    rules: job.rules || [],
    existing_spec: job.existing_spec || { panels: [] },
    sets: sets.map((s) => ({ no: s.no, label: s.label, m2: s.set_m2 == null ? null : Number(s.set_m2), status: s.status })),
    running_total_m2: Number(job.running_total_m2 || 0),
    offcuts: job.offcuts || [],
  };
}

// the first (and only) user message: the sheets for Claude to SEE, the files for its scripts, the task
export function firstContent({ sheets = [], uploads = [], text }) {
  return [
    ...sheets.map((s) => s.mime === "application/pdf"
      ? { type: "document", source: { type: "file", file_id: s.fileId }, title: s.name }
      : { type: "image", source: { type: "file", file_id: s.fileId } }),
    ...uploads.map((id) => ({ type: "container_upload", file_id: id })),
    { type: "text", text },
  ];
}

// one call's request — the same every round; only messages and the container id move on
export function requestBody({ messages, containerId, skillId, model = PANEL_MODEL() }) {
  return {
    model, max_tokens: 32000, betas: PANEL_BETAS,
    container: { ...(containerId ? { id: containerId } : {}), skills: [{ type: "custom", skill_id: skillId, version: "latest" }] },
    tools: [CODE_TOOL],
    messages,
  };
}

/* The files each code-execution call produced, in order: [[fileId, …], …] — one list per call that
   produced any. The worker reads names from the Files API and uses the LAST list holding
   manifest.json (the last publish.py — app-contract.md §2). */
export function outputGroups(messages) {
  const groups = [];
  for (const m of messages || []) {
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || b.type !== "bash_code_execution_tool_result") continue;
      const files = ((b.content && b.content.content) || []).filter((f) => f && f.file_id).map((f) => f.file_id);
      if (files.length) groups.push(files);
    }
  }
  return groups;
}

// the drafter's closing words (its last assistant text)
export function finalText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const t = m.content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
    if (t) return t;
  }
  return "";
}

// where a returned file goes in the bucket — never over anything
export function outputPath(jobId, draftId, name) {
  const safe = String(name || "file").replace(/[\\/]+/g, "_").replace(/[^\w .()+&,-]/g, "_").slice(0, 180);
  return `${jobId}/drafts/${draftId}/${safe}`;
}

// a manifest entry's role for a file name (manifest.json: { kind, files: [{ name, role }] } or [{ name, role }])
export function roleOf(manifest, name) {
  const files = Array.isArray(manifest) ? manifest : (manifest && Array.isArray(manifest.files) ? manifest.files : []);
  const hit = files.find((f) => f && (f.name === name || f.file === name || f.path === name || String(f.path || "").endsWith("/" + name)));
  if (hit && hit.role) return hit.role;
  if (/^preview-r\d+-c\d+\.png$/i.test(name)) return "preview_image";
  return null;
}

// add one call's token use to the run's running total
export function addUsage(total, u) {
  const t = { ...(total || {}) };
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) t[k] = (t[k] || 0) + ((u && u[k]) || 0);
  t.calls = (t.calls || 0) + 1;
  return t;
}
