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

// store one returned file — once (its path is unique; a second store of the same path is skipped)
async function keepFile(db, { jobId, draftId, name, buf, mime, role, kind = "draft_output" }) {
  const path = outputPath(jobId, draftId, name);
  const { data: had } = await db.from("panel_files").select("id").eq("storage_path", path).maybeSingle();
  if (had) return path;
  const up = await db.storage.from(BUCKET).upload(path, buf, { contentType: mime || "application/octet-stream", upsert: false });
  if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new Error(`storing ${name}: ${up.error.message}`);
  const { error } = await db.from("panel_files").insert({ job_id: jobId, kind, role, name, mime, size_bytes: buf.length, sha256: sha(buf), storage_path: path, draft_id: draftId, created_by: "panel worker" });
  if (error && !/duplicate key/i.test(error.message)) throw new Error(`recording ${name}: ${error.message}`);
  return path;
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

// ── a real run: the Messages API, saved after every call ──
async function realRun(t, run, anthropic) {
  const db = t.db;
  const skillId = process.env.PANEL_SKILL_ID;
  if (!skillId) throw new Error("PANEL_SKILL_ID is not set on the worker — upload the skill first");
  const { data: job } = await db.from("panel_jobs").select("*").eq("id", run.job_id).single();
  const { data: draft } = await db.from("panel_drafts").select("*").eq("id", run.draft_id).single();
  const save = (patch) => db.from("panel_runs").update({ ...patch, lease_until: new Date(Date.now() + LEASE_MS).toISOString(), updated_at: new Date().toISOString() }).eq("id", run.id);
  let messages = run.messages, containerId = run.container_id, usage = run.usage, input = run.input || {};

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
    const text = taskText(run.mode, { sheetNames: sent.map((s) => s.name), rev: draft.rev });
    messages = [{ role: "user", content: firstContent({ sheets: sent, uploads: [jf.id], text }) }];
    input = { ...input, task: text, uploaded: { sheets: sent.map((s) => s.fileId), job: jf.id } };
    await save({ messages, input });
  }

  for (let i = 0; !input.ended; i++) {
    if (i >= MAX_CALLS) throw new Error(`Still going after ${MAX_CALLS} rounds — stopped so it can be looked at`);
    const res = await anthropic.beta.messages.create(requestBody({ messages, containerId, skillId }));
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
    if (run.mode !== "draft" && run.mode !== "redraw") throw new Error(`Runs of mode "${run.mode}" come in a later part of the build`);
    const fake = run.fake || process.env.PANEL_FAKE === "on";
    const { got, text, containerId } = fake ? await fakeRun(t) : await realRun(t, run, anthropic);
    const manifest = parse((got.find((f) => f.name === "manifest.json") || {}).buf || Buffer.from(""));
    const files = got.map((f) => ({ ...f, role: roleOf(manifest, f.name) || (f.name === "manifest.json" ? "manifest" : null) }));
    for (const f of files) await keepFile(db, { jobId: run.job_id, draftId: run.draft_id, name: f.name, buf: f.buf, mime: f.mime, role: f.role });
    await finishDraft(db, run, files, text, containerId);
    await db.from("panel_runs").update({ status: "done", error: null, lease_until: null, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", run.id);
    log.log(`[panels] ${t.name} run ${run.id} done (${files.length} files${fake ? ", fake" : ""})`);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    const final = (run.attempts || 1) >= MAX_ATTEMPTS || /not set|come in a later part|No stored run/.test(msg);
    await db.from("panel_runs").update({ status: final ? "failed" : "queued", error: msg.slice(0, 2000), lease_until: null, updated_at: new Date().toISOString(), ...(final ? { finished_at: new Date().toISOString() } : {}) }).eq("id", run.id);
    if (final && run.draft_id) await db.from("panel_drafts").update({ state: "failed", updated_at: new Date().toISOString() }).eq("id", run.draft_id);
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
