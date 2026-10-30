// The panel drafting worker, end to end with a stand-in database and a stand-in Claude — the parts
// that matter most: a long run (pause_turn) saved after every call; a run that dies part-way carries
// on from what was saved, without re-uploading or re-asking; the LAST publish's files are the ones
// kept; a fake run replays stored files; failures retry, then stop with the reason.
import assert from "node:assert/strict";
import test from "node:test";
import { processRun } from "./panelWorker.js";

process.env.PANEL_SKILL_ID = "skill_test";
const quiet = { log() {}, error() {} };

// ── a tiny in-memory stand-in for the parts of supabase-js the worker uses ──
function fakeDb(seed) {
  const T = JSON.parse(JSON.stringify(seed.tables));
  const files = new Map(Object.entries(seed.storage || {}));
  const q = (table) => {
    let rows = () => T[table] || (T[table] = []);
    const f = []; let one = null; let patch = null; let ins = null;
    const api = {
      select() { return api; }, order() { return api; },
      eq(k, v) { f.push((r) => r[k] === v); return api; },
      in(k, vs) { f.push((r) => vs.includes(r[k])); return api; },
      update(p) { patch = p; return api; },
      insert(r) { ins = Array.isArray(r) ? r : [r]; return api; },
      single() { one = "single"; return api; }, maybeSingle() { one = "maybe"; return api; },
      then(res, rej) {
        try {
          if (ins) {
            for (const r of ins) { if (table === "panel_files" && rows().some((x) => x.storage_path === r.storage_path)) return res({ error: { message: "duplicate key" } }); rows().push({ id: "f" + rows().length, ...r }); }
            return res({ data: ins, error: null });
          }
          const hit = rows().filter((r) => f.every((fn) => fn(r)));
          if (patch) { hit.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(patch)))); return res({ data: hit, error: null }); }
          if (one) return res({ data: hit[0] || null, error: one === "single" && !hit[0] ? { message: "none" } : null });
          return res({ data: hit, error: null });
        } catch (e) { rej(e); }
      },
    };
    return api;
  };
  return {
    T, files,
    from: q,
    storage: { from: () => ({
      async upload(p, buf) { if (files.has(p)) return { error: { message: "The resource already exists" } }; files.set(p, Buffer.from(buf)); return { error: null }; },
      async download(p) { const b = files.get(p); return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: "not found " + p } }; },
      async list(prefix) { return { data: [...files.keys()].filter((k) => k.startsWith(prefix + "/")).map((k) => ({ name: k.slice(prefix.length + 1), metadata: {} })), error: null }; },
    }) },
  };
}

// ── a stand-in Claude: answers in turns; one round can throw (the process "dies") ──
function fakeClaude(turns, { failAt = -1 } = {}) {
  let n = 0; const uploads = []; const calls = [];
  const out = {
    "fm": { filename: "manifest.json", body: JSON.stringify({ kind: "draft", files: [{ name: "review.json", role: "review" }, { name: "spec.json", role: "spec" }] }) },
    "fr": { filename: "review.json", body: JSON.stringify({ status: "awaiting review", questions: ["1. S-03 return depth?"], job_rules: ["JOB: 80 jambs raw"] }) },
    "fs": { filename: "spec.json", body: JSON.stringify({ panels: [{ id: "S-01" }] }) },
    "fp": { filename: "preview-r1-c1.png", body: "PNG" },
    "old": { filename: "preview-r1-c1.png", body: "OLD" },
  };
  return {
    calls, uploads,
    files: {
      async upload({ file }) { uploads.push(file.name); return { id: "up" + uploads.length }; },
      async retrieveMetadata(id) { return { id, filename: out[id].filename, mime_type: "application/octet-stream" }; },
      async download(id) { return new Response(out[id].body); },
    },
    // the worker streams (a plain create of a 32k-token run is refused by the SDK): stream(body).finalMessage()
    beta: { messages: {
      async create() { throw new Error("Streaming is required for operations that may take longer than 10 minutes"); },
      stream(body) {
        calls.push(JSON.parse(JSON.stringify(body)));
        const i = n++;
        return { async finalMessage() { if (i === failAt) throw new Error("socket hang up"); return turns[i]; } };
      },
    } },
  };
}
const res = (ids) => ({ type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_result", content: ids.map((id) => ({ type: "bash_code_execution_output", file_id: id })) } });
const TURNS = [
  { stop_reason: "pause_turn", container: { id: "cntr_1" }, usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "text", text: "Reading the sheets" }, res(["old"])] },
  { stop_reason: "end_turn", container: { id: "cntr_1" }, usage: { input_tokens: 50, output_tokens: 20 }, content: [res(["fm", "fr", "fs", "fp"]), { type: "text", text: "Awaiting review. 1 question." }] },
];
const seed = () => ({
  tables: {
    panel_jobs: [{ id: "pj_1", name: "6197 Storage King Croydon", settings: { colour: "White" }, rules: [], existing_spec: { panels: [] }, running_total_m2: 0, offcuts: [] }],
    panel_drafts: [{ id: "d1", job_id: "pj_1", rev: 1, sheet_file_ids: ["s1"], state: "drafting" }],
    panel_files: [{ id: "s1", job_id: "pj_1", kind: "sheet", name: "IMG_0412.jpg", mime: "image/jpeg", storage_path: "pj_1/sheets/s1.jpg" }],
    panel_runs: [{ id: "r1", job_id: "pj_1", draft_id: "d1", mode: "draft", status: "running", attempts: 1, input: {}, messages: null }],
    panel_sets: [],
  },
  storage: { "pj_1/sheets/s1.jpg": Buffer.from("JPEG") },
});

test("a long run: pause_turn is sent back as is, every call saved; the LAST publish's files kept; the draft reads its review", async () => {
  const db = fakeDb(seed()); const claude = fakeClaude(TURNS);
  await processRun({ name: "live", db }, db.T.panel_runs[0], claude, quiet);
  assert.equal(claude.calls.length, 2);
  assert.deepEqual(claude.calls[0].messages[0].content.map((b) => b.type), ["image", "container_upload", "text"]);
  assert.equal(claude.calls[1].container.id, "cntr_1");                              // the container is reused
  assert.equal(claude.calls[1].messages.length, 2);                                   // nothing added on a pause
  assert.deepEqual(claude.uploads, ["IMG_0412.jpg", "job.json"]);
  const run = db.T.panel_runs[0], draft = db.T.panel_drafts[0];
  assert.equal(run.status, "done"); assert.equal(run.usage.calls, 2); assert.equal(run.input.ended, true);
  assert.equal(draft.state, "review"); assert.equal(draft.review_status, "awaiting review");
  assert.deepEqual(draft.job_rules, ["JOB: 80 jambs raw"]); assert.deepEqual(draft.spec.panels, [{ id: "S-01" }]);
  assert.equal(draft.final_text, "Awaiting review. 1 question."); assert.equal(draft.container_id, "cntr_1");
  const kept = db.T.panel_files.filter((f) => f.kind === "draft_output");
  assert.deepEqual(kept.map((f) => f.name).sort(), ["manifest.json", "preview-r1-c1.png", "review.json", "spec.json"]);
  assert.equal(db.files.get("pj_1/drafts/d1/preview-r1-c1.png").toString(), "PNG");   // the last publish's, not the earlier one
  assert.equal(kept.find((f) => f.name === "preview-r1-c1.png").role, "preview_image");
});

test("a redraw (part 2): the earlier reading.json and the answers go with the sheets, and the task says redraw rev 2", async () => {
  const s = seed();
  s.tables.panel_drafts = [
    { id: "d1", job_id: "pj_1", rev: 1, sheet_file_ids: ["s1"], state: "superseded", reading: { spec: { panels: [{ id: "E-83" }] }, questions: ["1. E-83 or E-33?"] } },
    { id: "d2", job_id: "pj_1", rev: 2, redraw_of: "d1", sheet_file_ids: ["s1"], state: "drafting", answers: [{ question: "E-83 or E-33?", answer: "E-83" }] },
  ];
  s.tables.panel_runs = [{ id: "r2", job_id: "pj_1", draft_id: "d2", mode: "redraw", status: "running", attempts: 1, input: {}, messages: null }];
  const db = fakeDb(s); const claude = fakeClaude(TURNS);
  await processRun({ name: "live", db }, db.T.panel_runs[0], claude, quiet);
  assert.deepEqual(claude.uploads, ["IMG_0412.jpg", "job.json", "reading.json", "answers.json"]);
  const first = claude.calls[0].messages[0].content;
  assert.deepEqual(first.map((b) => b.type), ["image", "container_upload", "container_upload", "container_upload", "text"]);
  assert.match(first[first.length - 1].text, /^Redraw\. Previous reading: reading\.json\. Answers: answers\.json .* rev 2\./);
  assert.equal(db.T.panel_drafts[1].state, "review");
});

test("⚠ a redraw of a draft with no reading.json fails with a reason, never draws from nothing", async () => {
  const s = seed();
  s.tables.panel_drafts = [{ id: "d1", job_id: "pj_1", rev: 1, sheet_file_ids: ["s1"], state: "superseded", reading: null },
    { id: "d2", job_id: "pj_1", rev: 2, redraw_of: "d1", sheet_file_ids: ["s1"], state: "drafting", answers: [] }];
  s.tables.panel_runs = [{ id: "r2", job_id: "pj_1", draft_id: "d2", mode: "redraw", status: "running", attempts: 3, input: {}, messages: null }];
  const db = fakeDb(s); const claude = fakeClaude(TURNS);
  await processRun({ name: "live", db }, db.T.panel_runs[0], claude, quiet);
  assert.match(String(db.T.panel_runs[0].error || ""), /no reading\.json/);
  assert.equal(claude.calls.length, 0);
});

test("a run that dies part-way carries on from what was saved — no re-upload, no repeated call", async () => {
  const db = fakeDb(seed()); const claude = fakeClaude(TURNS, { failAt: 1 });
  await processRun({ name: "live", db }, db.T.panel_runs[0], claude, quiet);
  const run = db.T.panel_runs[0];
  assert.equal(run.status, "queued");                 // retried later, not failed
  assert.match(run.error, /socket hang up/);
  assert.equal(run.messages.length, 2);               // the first call's answer is kept
  assert.equal(run.container_id, "cntr_1");
  run.status = "running"; run.attempts = 2;
  const claude2 = fakeClaude([TURNS[1], TURNS[1]]);
  await processRun({ name: "live", db }, run, claude2, quiet);
  assert.equal(run.status, "done");
  assert.deepEqual(claude2.uploads, []);              // the sheets weren't sent again
  assert.equal(claude2.calls.length, 1);              // it carried on with the one call left
  assert.equal(claude2.calls[0].messages.length, 2);
  assert.equal(db.T.panel_drafts[0].state, "review");
});

test("a fake run replays the stored real draft — no API at all", async () => {
  const s = seed();
  Object.assign(s.storage, { "fixtures/panel-draft/review.json": Buffer.from(JSON.stringify({ status: "needs attention - not drawn", questions: [] })),
    "fixtures/panel-draft/manifest.json": Buffer.from(JSON.stringify({ files: [{ name: "review.json", role: "review" }] })),
    "fixtures/panel-draft/preview-r1-c1.png": Buffer.from("PNG") });
  const db = fakeDb(s); db.T.panel_runs[0].fake = true;
  await processRun({ name: "dev", db }, db.T.panel_runs[0], null, quiet);
  assert.equal(db.T.panel_runs[0].status, "done");
  assert.equal(db.T.panel_drafts[0].review_status, "needs attention - not drawn");
  assert.match(db.T.panel_drafts[0].final_text, /Fake run/);
  assert.equal(db.T.panel_files.filter((f) => f.kind === "draft_output").length, 3);
});

test("failures: retried, then stopped with the reason on the run and the draft", async () => {
  const db = fakeDb(seed()); const run = db.T.panel_runs[0]; run.attempts = 3;
  await processRun({ name: "live", db }, run, fakeClaude([], { failAt: 0 }), quiet);
  assert.equal(run.status, "failed"); assert.match(run.error, /socket hang up/); assert.ok(run.finished_at);
  assert.equal(db.T.panel_drafts[0].state, "failed");
  const db2 = fakeDb(seed()); db2.T.panel_runs[0].mode = "release";
  await processRun({ name: "live", db: db2 }, db2.T.panel_runs[0], fakeClaude([]), quiet);
  assert.match(db2.T.panel_runs[0].error, /later part of the build/);
  assert.equal(db2.T.panel_runs[0].status, "failed");                                // not retried: it can't work yet
  const db3 = fakeDb(seed()); db3.T.panel_runs[0].fake = true;
  await processRun({ name: "dev", db: db3 }, db3.T.panel_runs[0], null, quiet);
  assert.match(db3.T.panel_runs[0].error, /No stored run to replay/);
});

test("no review.json back is a failure with a reason, never an empty review", async () => {
  const db = fakeDb(seed());
  const noReview = [{ stop_reason: "end_turn", container: { id: "c" }, usage: {}, content: [res(["fm", "fs"])] }];
  const run = db.T.panel_runs[0]; run.attempts = 3;
  await processRun({ name: "live", db }, run, fakeClaude(noReview), quiet);
  assert.equal(run.status, "failed"); assert.match(run.error, /no review\.json/);
});
