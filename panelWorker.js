// Panel drafting runs — the worker (Jed 2026-10-29: "Render, always-on"). Takes queued runs from
// alclad.app (panel_runs, via panel_claim_run), runs the alclad-panel-drafting skill through the
// Messages API, and stores what comes back. The pure half — what is sent, how the answer is read — is
// panelRun.js.
//
//   • Resumable: the conversation and container id are saved after EVERY call, under a lease. If this
//     process dies, the lease runs out and the next tick carries on from the saved messages.
//   • Idempotent: a returned file already stored (same path) is not stored again; nothing is ever
//     overwritten (panel_files is append-only in the database).
//   • A fake run (the run's `fake` flag, or PANEL_FAKE=on) replays a stored real draft from
//     panel-drafting/fixtures/panel-draft/ — no API call, no spend.
//
// Env: PANEL_WORKER=on to run it · ANTHROPIC_API_KEY · PANEL_SKILL_ID · PANEL_MODEL (optional) ·
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (live) · PANEL_DEV_SUPABASE_URL + PANEL_DEV_SERVICE_ROLE_KEY
// (optional: dev too, for testing).
import crypto from "crypto";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { taskText, jobJson, firstContent, requestBody, outputGroups, finalText, outputPath, roleOf, addUsage, MAX_CALLS, LEASE_MS } from "./panelRun.js";

const BUCKET = "panel-drafting";
const FIXTURE = "fixtures/panel-draft/";
const MAX_ATTEMPTS = 3;
const WORKER_ID = `render-${crypto.randomBytes(4).toString("hex")}`;

export function panelTargets(env = process.env) {
  const out = [];
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) out.push({ name: "live", db: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY) });
  if (env.PANEL_DEV_SUPABASE_URL && env.PANEL_DEV_SERVICE_ROLE_KEY) out.push({ name: "dev", db: createClient(env.PANEL_DEV_SUPABASE_URL, env.PANEL_DEV_SERVICE_ROLE_KEY) });
  return out;
}

const bufOf = async (blob) => Buffer.from(await blob.arrayBuffer());
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const parse = (buf) => { try { return JSON.parse(buf.toString("utf8")); } catch { return null; } };

// store one returned file — once (its path is unique; a second store of the same path is skipped).
// Returns { path, id, had } — `had` when it was already stored (a resumed run).
async function keepFile(db, { jobId, draftId, name, buf, mime, role, kind = "draft_output", path = null, setId = null, version = null }) {
  path = path || outputPath(jobId, draftId, name);
  const { data: had } = await db.from("panel_files").select("id").eq("storage_path", path).maybeSingle();
  if (had) return { path, id: had.id, had: true };
  const up = await db.storage.from(BUCKET).upload(path, buf, { contentType: mime || "application/octet-stream", upsert: false });
  if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new Error(`storing ${name}: ${up.error.message}`);
  const { data: row, error } = await db.from("panel_files").insert({ job_id: jobId, kind, role, name, mime, size_bytes: buf.length, sha256: sha(buf), storage_path: path, draft_id: draftId, set_id: setId, version, created_by: "panel worker" }).select("id").maybeSingle();
  if (error && !/duplicate key/i.test(error.message)) throw new Error(`recording ${name}: ${error.message}`);
  return { path, id: row ? row.id : null, had: false };
}

/* WHAT A RELEASE MAKES (part 3, review-loop.md "Release"): the set's files under <job>/sets/<n>/; the Main
   Drawing File with this set appended, as the job's next VERSION under <job>/main/ (the job's running record —
   never overwritten, every version kept); and from result.json the set's m2, the running total, the nest layout
   (what a reissue cuts on), the sheets report and file checks. The job carries on from it: its running total,
   its offcut library, its current Main Drawing File, and this set's panels added to existing_spec so the next
   set numbers on and checks its IDs. The approved draft becomes released. */
async function finishRelease(db, run, files) {
  const { data: set } = await db.from("panel_sets").select("*").eq("id", run.set_id).single();
  const { data: job } = await db.from("panel_jobs").select("*").eq("id", run.job_id).single();
  const { data: draft } = await db.from("panel_drafts").select("spec").eq("id", run.draft_id).single();
  const resultFile = files.find((f) => f.role === "release_result" || f.name === "result.json");
  const result = resultFile ? parse(resultFile.buf) : null;
  if (!result) throw new Error("The release returned no result.json — the set can't be recorded");
  const safe = (n) => String(n || "file").replace(/[\\/]+/g, "_").replace(/[^\w .()+&,-]/g, "_").slice(0, 180);
  let mainId = null;
  for (const f of files) {
    if (f.role === "main_drawing_file") {
      const path = `${run.job_id}/main/set-${set.no}-${String(run.id).slice(0, 8)} - ${safe(f.name)}`;
      const { data: vs } = await db.from("panel_files").select("version").eq("job_id", run.job_id).eq("kind", "main");
      const next = Math.max(0, ...(vs || []).map((v) => Number(v.version) || 0)) + 1;
      const kept = await keepFile(db, { jobId: run.job_id, draftId: run.draft_id, name: f.name, buf: f.buf, mime: f.mime, role: f.role, kind: "main", path, setId: set.id, version: next });
      mainId = kept.id;
    } else {
      await keepFile(db, { jobId: run.job_id, draftId: run.draft_id, name: f.name, buf: f.buf, mime: f.mime, role: f.role, kind: "release_output", path: `${run.job_id}/sets/${set.no}/${String(run.id).slice(0, 8)}/${safe(f.name)}`, setId: set.id });
    }
  }
  const now = new Date().toISOString();
  await db.from("panel_sets").update({
    status: "released", set_m2: result.set_m2 ?? null, total_m2: result.total_m2 ?? null,
    layout: set.ordered_at && set.layout ? set.layout : (result.layout ?? null),   // ⚠ an ordered nest is never replaced
    sheets: result.sheets ?? null, qa: result.qa ?? null, main_file_id: mainId || set.main_file_id || null, released_at: now, updated_at: now,
  }).eq("id", set.id);
  const have = (job.existing_spec && Array.isArray(job.existing_spec.panels)) ? job.existing_spec.panels : [];
  const seen = new Set(have.flatMap((p) => (p && Array.isArray(p.ids) ? p.ids : [])));
  const fresh = ((draft && draft.spec && draft.spec.panels) || []).filter((p) => p && Array.isArray(p.ids) && p.ids.length && !p.ids.some((i) => seen.has(i)));
  await db.from("panel_jobs").update({
    running_total_m2: result.total_m2 ?? job.running_total_m2,
    offcuts: Array.isArray(result.library) ? result.library : job.offcuts,
    current_main_file_id: mainId || job.current_main_file_id,
    existing_spec: { ...(job.existing_spec || {}), panels: [...have, ...fresh] },
    updated_at: now,
  }).eq("id", job.id);
  await db.from("panel_drafts").update({ state: "released", updated_at: now }).eq("id", run.draft_id);
}

// what the draft becomes once its files are in: review.json says how it went
async function finishDraft(db, run, files, text, containerId) {
  const by = (role, name) => files.find((f) => f.role === role || f.name === name);
  const review = by("review", "review.json"), spec = by("spec", "spec.json"), reading = by("reading", "reading.json");
  const rv = review ? parse(review.buf) : null;
  const rd = reading ? parse(reading.buf) : null;
  if (!rv) throw new Error("The drafter returned no review.json — nothing to review");
  await db.from("panel_drafts").update({
    state: "review", review_status: String(rv.status || "awaiting review"), review: rv,
    spec: spec ? parse(spec.buf) : null, reading: rd, job_rules: rv.job_rules || (rd && rd.job_rules) || null,
    final_text: text || null, container_id: containerId || null, updated_at: new Date().toISOString(),
  }).eq("id", run.draft_id);
}

/* A RELEASE's first message (part 3): no sheets — a release is built from the APPROVED spec.json, never from a
   fresh reading — but job.json, spec.json, offcuts.json, the locked layout.json when sheets were ordered, and
   the Main Drawing File to append to. A REISSUE starts from the running total and the Main Drawing File version
   BEFORE this set, so nothing is counted or appended twice (panel_reissue allows only the latest set). */
async function releaseStart(db, anthropic, run, job, draft) {
  const { data: set } = await db.from("panel_sets").select("*").eq("id", run.set_id).single();
  if (!set) throw new Error("The set being released is gone");
  if (!draft || !draft.spec) throw new Error("The approved draft has no spec.json to release");
  const reissue = !!(run.input && run.input.reissue);
  let main = null;
  if (reissue && set.main_file_id) {
    const { data: mine } = await db.from("panel_files").select("version").eq("id", set.main_file_id).maybeSingle();
    const v = mine ? Number(mine.version) : 0;
    if (v > 1) main = (await db.from("panel_files").select("*").eq("job_id", job.id).eq("kind", "main").eq("version", v - 1).maybeSingle()).data;
  } else if (job.current_main_file_id) {
    main = (await db.from("panel_files").select("*").eq("id", job.current_main_file_id).maybeSingle()).data;
  }
  const before = reissue ? Math.max(0, Number(job.running_total_m2 || 0) - Number(set.set_m2 || 0)) : Number(job.running_total_m2 || 0);
  const { data: sets } = await db.from("panel_sets").select("no, label, set_m2, status").eq("job_id", job.id).neq("id", set.id).order("no").then((r) => r, () => ({ data: [] }));
  const json = async (v, name) => (await anthropic.files.upload({ file: await toFile(Buffer.from(JSON.stringify(v, null, 2)), name, { type: "application/json" }) })).id;
  const uploads = [
    await json(jobJson({ ...job, running_total_m2: before }, sets || []), "job.json"),
    await json(draft.spec, "spec.json"),
    await json(Array.isArray(job.offcuts) ? job.offcuts : [], "offcuts.json"),
  ];
  const layout = !!(set.ordered_at && set.layout);
  if (layout) uploads.push(await json(set.layout, "layout.json"));
  if (main) {
    const { data: blob, error } = await db.storage.from(BUCKET).download(main.storage_path);
    if (error) throw new Error(`reading the Main Drawing File: ${error.message}`);
    uploads.push((await anthropic.files.upload({ file: await toFile(await bufOf(blob), main.name, { type: main.mime || "application/dxf" }) })).id);
  }
  const text = taskText("release", { setNo: set.no, setLabel: set.label, date: set.date, mainFile: main ? main.name : null, layout });
  return { text, uploads };
}

// ── a real run: the Messages API, saved after every call ──
async function realRun(t, run, anthropic) {
  const db = t.db;
  const skillId = process.env.PANEL_SKILL_ID;
  if (!skillId) throw new Error("PANEL_SKILL_ID is not set on the worker — upload the skill first");
  const { data: job } = await db.from("panel_jobs").select("*").eq("id", run.job_id).single();
  const { data: draft } = await db.from("panel_drafts").select("*").eq("id", run.draft_id).single();
  const save = (patch) => db.from("panel_runs").update({ ...patch, lease_until: new Date(Date.now() + LEASE_MS).toISOString(), updated_at: new Date().toISOString() }).eq("id", run.id);
  let messages = run.messages, containerId = run.container_id, usage = run.usage, input = run.input || {};

  if (!messages && run.mode === "release") {
    const { text, uploads } = await releaseStart(db, anthropic, run, job, draft);
    messages = [{ role: "user", content: firstContent({ sheets: [], uploads, text }) }];
    input = { ...input, task: text, uploaded: { files: uploads } };
    await save({ messages, input });
  }

  if (!messages) {
    // the sheets for Claude to SEE, job.json for its scripts — uploaded once, their ids saved
    const { data: sheets } = await db.from("panel_files").select("*").in("id", draft.sheet_file_ids || []);
    const order = new Map((draft.sheet_file_ids || []).map((id, i) => [id, i]));
    sheets.sort((a, b) => order.get(a.id) - order.get(b.id));
    const sent = [];
    for (const s of sheets) {
      const { data: blob, error } = await db.storage.from(BUCKET).download(s.storage_path);
      if (error) throw new Error(`reading sheet ${s.name}: ${error.message}`);
      const f = await anthropic.files.upload({ file: await toFile(await bufOf(blob), s.name, { type: s.mime || "application/octet-stream" }) });
      sent.push({ fileId: f.id, mime: s.mime, name: s.name });
    }
    const { data: sets } = await db.from("panel_sets").select("no, label, set_m2, status").eq("job_id", job.id).order("no").then((r) => r, () => ({ data: [] }));
    const jf = await anthropic.files.upload({ file: await toFile(Buffer.from(JSON.stringify(jobJson(job, sets || [], run.input || {}), null, 2)), "job.json", { type: "application/json" }) });
    const uploads = [jf.id];
    /* A REDRAW (part 2, review-loop.md "Answering"): the earlier draft's reading.json and the person's answers
       go with the sheets, so the drafter starts from what it read and changes only what the answers say. */
    if (run.mode === "redraw") {
      const { data: prev } = await db.from("panel_drafts").select("reading").eq("id", draft.redraw_of).single();
      if (!prev || !prev.reading) throw new Error("The draft being redrawn has no reading.json to start from");
      const json = (v, name) => toFile(Buffer.from(JSON.stringify(v, null, 2)), name, { type: "application/json" });
      const rf = await anthropic.files.upload({ file: await json(prev.reading, "reading.json") });
      const af = await anthropic.files.upload({ file: await json(draft.answers || [], "answers.json") });
      uploads.push(rf.id, af.id);
    }
    const text = taskText(run.mode, { sheetNames: sent.map((s) => s.name), rev: draft.rev, draftName: job.name });
    messages = [{ role: "user", content: firstContent({ sheets: sent, uploads, text }) }];
    input = { ...input, task: text, uploaded: { sheets: sent.map((s) => s.fileId), job: jf.id, ...(uploads.length > 1 ? { reading: uploads[1], answers: uploads[2] } : {}) } };
    await save({ messages, input });
  }

  for (let i = 0; !input.ended; i++) {
    if (i >= MAX_CALLS) throw new Error(`Still going after ${MAX_CALLS} rounds — stopped so it can be looked at`);
    /* ⚠ STREAMED (prod 2026-10-30, the first real draft: "Streaming is required for operations that may take
       longer than 10 minutes"). With 32k output tokens the SDK refuses a plain create before sending it;
       a stream with finalMessage() is the same request and the same answer. */
    const res = await anthropic.beta.messages.stream(requestBody({ messages, containerId, skillId })).finalMessage();
    messages = [...messages, { role: "assistant", content: res.content }];
    containerId = (res.container && res.container.id) || containerId;
    usage = addUsage(usage, res.usage);
    if (res.stop_reason !== "pause_turn") input = { ...input, ended: true, stop_reason: res.stop_reason };
    await save({ messages, container_id: containerId, usage, input });
  }

  // the files from the LAST publish.py: the last group of outputs holding manifest.json
  const groups = outputGroups(messages);
  let picked = null;
  for (let g = groups.length - 1; g >= 0 && !picked; g--) {
    const metas = await Promise.all(groups[g].map((id) => anthropic.files.retrieveMetadata(id)));
    if (metas.some((m) => m.filename === "manifest.json")) picked = metas;
  }
  if (!picked) throw new Error("The drafter didn't publish (no manifest.json in its outputs)");
  const got = [];
  for (const m of picked) {
    const res = await anthropic.files.download(m.id);
    got.push({ name: m.filename, mime: m.mime_type, buf: Buffer.from(await res.arrayBuffer()) });
  }
  return { got, text: finalText(messages), containerId };
}

// ── a fake run: a stored real draft, replayed ──
async function fakeRun(t) {
  const { data: list, error } = await t.db.storage.from(BUCKET).list(FIXTURE.replace(/\/$/, ""), { limit: 500 });
  if (error) throw new Error("reading the stored run: " + error.message);
  if (!list || !list.length) throw new Error(`No stored run to replay — put a real draft's files in ${BUCKET}/${FIXTURE}`);
  const got = [];
  for (const f of list.filter((x) => x.name && !x.name.endsWith("/"))) {
    const { data: blob, error: e } = await t.db.storage.from(BUCKET).download(FIXTURE + f.name);
    if (e) throw new Error(`reading ${f.name}: ${e.message}`);
    got.push({ name: f.name, mime: (f.metadata && f.metadata.mimetype) || null, buf: await bufOf(blob) });
  }
  return { got, text: "Fake run — a stored real draft, replayed (no API call).", containerId: null };
}

export async function processRun(t, run, anthropic, log = console) {
  const db = t.db;
  try {
    if (!["draft", "redraw", "release"].includes(run.mode)) throw new Error(`Runs of mode "${run.mode}" come in a later part of the build`);
    const release = run.mode === "release";
    // a release is never a practice replay: its files are what production cuts from
    const fake = !release && (run.fake || process.env.PANEL_FAKE === "on");
    const { got, text, containerId } = fake ? await fakeRun(t) : await realRun(t, run, anthropic);
    const manifest = parse((got.find((f) => f.name === "manifest.json") || {}).buf || Buffer.from(""));
    const files = got.map((f) => ({ ...f, role: roleOf(manifest, f.name) || (f.name === "manifest.json" ? "manifest" : f.name === "result.json" ? "release_result" : null) }));
    if (release) await finishRelease(db, run, files);
    else {
      for (const f of files) await keepFile(db, { jobId: run.job_id, draftId: run.draft_id, name: f.name, buf: f.buf, mime: f.mime, role: f.role });
      await finishDraft(db, run, files, text, containerId);
    }
    await db.from("panel_runs").update({ status: "done", error: null, lease_until: null, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", run.id);
    log.log(`[panels] ${t.name} run ${run.id} done (${files.length} files${fake ? ", fake" : ""})`);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    const final = (run.attempts || 1) >= MAX_ATTEMPTS || /not set|come in a later part|No stored run/.test(msg);
    await db.from("panel_runs").update({ status: final ? "failed" : "queued", error: msg.slice(0, 2000), lease_until: null, updated_at: new Date().toISOString(), ...(final ? { finished_at: new Date().toISOString() } : {}) }).eq("id", run.id);
    // a failed release fails its SET — the approved draft stays approved, and Try again releases it
    if (final && run.mode === "release" && run.set_id) await db.from("panel_sets").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", run.set_id);
    else if (final && run.draft_id) await db.from("panel_drafts").update({ state: "failed", updated_at: new Date().toISOString() }).eq("id", run.draft_id);
    log.error(`[panels] ${t.name} run ${run.id} ${final ? "FAILED" : "will retry"}: ${msg}`);
  }
}

export function startPanelWorker({ log = console, everyMs = 15000 } = {}) {
  if (process.env.PANEL_WORKER !== "on") { log.log("[panels] worker off (set PANEL_WORKER=on)"); return null; }
  const targets = panelTargets();
  const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const t of targets) {
        const { data, error } = await t.db.rpc("panel_claim_run", { p_worker: WORKER_ID, p_lease_seconds: Math.round(LEASE_MS / 1000) });
        if (error) { if (!/panel_claim_run/.test(error.message)) log.error(`[panels] ${t.name} claim: ${error.message}`); continue; }
        const run = Array.isArray(data) ? data[0] : data;
        if (!run) continue;
        if (!anthropic && !(run.fake || process.env.PANEL_FAKE === "on")) {
          await t.db.from("panel_runs").update({ status: "failed", error: "ANTHROPIC_API_KEY is not set on the worker", finished_at: new Date().toISOString() }).eq("id", run.id);
          continue;
        }
        await processRun(t, run, anthropic, log);
      }
    } catch (e) { log.error("[panels] tick:", e && e.message); }
    busy = false;
  };
  const timer = setInterval(tick, everyMs);
  timer.unref && timer.unref();
  setTimeout(tick, 5000).unref();
  log.log(`[panels] worker ${WORKER_ID} on — ${targets.map((t) => t.name).join(" + ") || "no database"}`);
  return { tick };
}
