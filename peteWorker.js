// PETE, REBUILT LIKE CLAUDE DESKTOP — the worker (Jed 2026-11-16: "purely the chat so we start from a Claude Desktop
// like situation"). Takes the next queued turn of a job's chat (alclad.app pete_chats, via pete_claim_turn), gives
// Claude the new messages with the panel drafting skill and code execution in the job's own container, and writes
// his reply - and the files he saved - back into the chat (pete_worker_save). The pure half is peteTurn.js.
//
//   • Resumable: Claude's conversation and the container id are saved after EVERY call, under a lease. If this
//     process dies, the lease runs out and the next tick carries on from what was saved.
//   • Messages are only ever APPENDED to the chat (pete_worker_save) - someone writing while he works is never lost,
//     and finishing leaves the turn queued again for them.
//   • Files he saves (code execution's $OUTPUT_DIR) are stored on the job as panel_files kind 'chat_output'; the G
//     connector copies DXF/XLSX/nest.json to Claude DXFs and PDFs to Layout Drawings (docs-connector sync_list).
//
// Env: PETE_WORKER=on · PETE_TARGETS=dev (default - the dev database only; "dev,live" when it's shipped) ·
// ANTHROPIC_API_KEY · PANEL_SKILL_ID · PETE_MODEL (optional) · PANEL_DEV_SUPABASE_URL + PANEL_DEV_SERVICE_ROLE_KEY ·
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (live).
import crypto from "crypto";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { panelTargets } from "./panelWorker.js";
import { jobJson } from "./panelRun.js";
import { runFolderTool, FOLDER_TOOL_NAMES } from "./peteFolder.js";
import { peteSystem, userTurn, withUserTurn, peteRequest, replyOf, noteOf, turnFileIds, chatFilePath, PETE_MAX_CALLS, PETE_LEASE_MS } from "./peteTurn.js";

const BUCKET = "panel-drafting";
const IMAGES = "pete-chat-images";
const WORKER_ID = `pete-${crypto.randomBytes(4).toString("hex")}`;
const LEASE_S = Math.round(PETE_LEASE_MS / 1000);
const bufOf = async (blob) => Buffer.from(await blob.arrayBuffer());
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export function peteTargets(env = process.env) {
  const want = String(env.PETE_TARGETS || "dev").split(",").map((s) => s.trim()).filter(Boolean);
  return panelTargets(env).filter((t) => want.includes(t.name));
}

async function save(db, chatId, append = [], set = {}, status = "running") {
  const { data, error } = await db.rpc("pete_worker_save", { p_chat: chatId, p_append: append, p_set: set, p_status: status, p_lease_seconds: LEASE_S });
  if (error) throw new Error("saving the chat: " + error.message);
  return data;
}

// a picture or sheet, uploaded to the Files API once (its id kept on the chat's `uploads`)
async function uploadOnce(db, anthropic, uploads, key, { bucket, path, name, mime }) {
  if (uploads[key]) return uploads[key];
  const { data: blob, error } = await db.storage.from(bucket).download(path);
  if (error || !blob) throw new Error(`reading ${name}: ${(error && error.message) || "not found"}`);
  const f = await anthropic.files.upload({ file: await toFile(await bufOf(blob), name, { type: mime || "application/octet-stream" }) });
  uploads[key] = { file_id: f.id, name, mime: mime || null };
  return uploads[key];
}

// the job's own files for a NEW container: job.json, and the current Main Drawing File
async function jobUploads(db, anthropic, job) {
  const { data: sets } = await db.from("panel_sets").select("no, label, set_m2, status").eq("job_id", job.id).order("no").then((r) => r, () => ({ data: [] }));
  const jf = await anthropic.files.upload({ file: await toFile(Buffer.from(JSON.stringify(jobJson(job, sets || []), null, 2)), "job.json", { type: "application/json" }) });
  const ids = [jf.id];
  if (job.current_main_file_id) {
    const { data: mf } = await db.from("panel_files").select("name, storage_path, mime").eq("id", job.current_main_file_id).maybeSingle();
    if (mf) {
      const { data: blob } = await db.storage.from(BUCKET).download(mf.storage_path);
      if (blob) ids.push((await anthropic.files.upload({ file: await toFile(await bufOf(blob), mf.name, { type: mf.mime || "application/dxf" }) })).id);
    }
  }
  return ids;
}

export async function runTurn(t, chat, anthropic, { log = console, today = null } = {}) {
  const db = t.db;
  const skillId = process.env.PANEL_SKILL_ID;
  if (!skillId) throw new Error("PANEL_SKILL_ID is not set on the worker - upload the skill first");
  const { data: job } = await db.from("panel_jobs").select("*").eq("id", chat.job_id).single();
  if (!job) throw new Error("The chat's job is gone");
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  let api = Array.isArray(chat.api_messages) ? chat.api_messages : [];
  let containerId = chat.container_id || null;
  let usage = chat.usage || {};
  const uploads = { ...(chat.uploads || {}) };
  const upto = messages.length;
  const fresh = messages.slice(chat.api_upto || 0).filter((m) => m && m.role === "user");
  // a turn cut off mid-way (the worker died, or it failed): its question never got a final answer - carry on with it
  const midTurn = (api.length && api[api.length - 1].role === "user") || usage.last_stop === "pause_turn"

  if (fresh.length) {
    // their pictures and sheets, to the Files API (once)
    for (const m of fresh) {
      for (const p of m.images || []) await uploadOnce(db, anthropic, uploads, p, { bucket: IMAGES, path: p, name: p.split("/").pop(), mime: /\.png$/i.test(p) ? "image/png" : "image/jpeg" });
      if ((m.sheets || []).length) {
        const { data: rows } = await db.from("panel_files").select("id, name, mime, storage_path").in("id", m.sheets);
        for (const r of rows || []) await uploadOnce(db, anthropic, uploads, r.id, { bucket: BUCKET, path: r.storage_path, name: r.name, mime: r.mime });
      }
    }
    const jobIds = containerId ? [] : await jobUploads(db, anthropic, job);
    api = withUserTurn(api, userTurn(fresh, uploads, jobIds));
    await save(db, chat.id, [], { api_messages: api, api_upto: upto, uploads, turn_note: "Reading it…" });
  } else if (!midTurn) {
    await save(db, chat.id, [], { api_upto: upto }, "done");
    return { idle: true };
  }

  const system = peteSystem({ job, waiting: chat.waiting, today: today || new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Melbourne" }) });
  const start = api.length;
  let waiting;     // undefined = untouched
  for (let i = 0; ; i++) {
    if (i >= PETE_MAX_CALLS) throw new Error(`Still going after ${PETE_MAX_CALLS} rounds - stopped so it can be looked at`);
    let res;
    try {
      res = await anthropic.beta.messages.stream(peteRequest({ messages: api, containerId, skillId, system })).finalMessage();
    } catch (e) {
      // the container ran out (Desktop's session ending): start a new one with the job's files, once
      if (containerId && /container/i.test(String(e && e.message)) && i === 0) {
        log.log(`[pete] ${t.name} chat ${chat.id}: container gone - starting a new one`);
        containerId = null;
        const ids = await jobUploads(db, anthropic, job);
        api = withUserTurn(api, [...ids.map((id) => ({ type: "container_upload", file_id: id })), { type: "text", text: "(The code container was restarted - earlier files are gone; job.json and the Main Drawing File are uploaded again.)" }]);
        continue;
      }
      throw e;
    }
    api = [...api, { role: "assistant", content: res.content }];
    containerId = (res.container && res.container.id) || containerId;
    usage = { ...addUsage(usage, res.usage), last_stop: res.stop_reason || null };
    // his waiting_on calls: done here, answered, and the turn carries on
    const uses = (res.content || []).filter((b) => b && b.type === "tool_use");
    if (uses.length) {
      const results = [];
      for (const u of uses) {
        if (u.name === "waiting_on") {
          waiting = String((u.input && u.input.note) || "").trim().slice(0, 200);
          results.push({ type: "tool_result", tool_use_id: u.id, content: waiting ? `Parked: the job shows "Waiting on ${waiting}".` : "Cleared: the job is no longer waiting." });
        } else if (FOLDER_TOOL_NAMES.includes(u.name)) {
          // the job's folder on G, read-only (peteFolder.js)
          try { results.push({ type: "tool_result", tool_use_id: u.id, content: (await runFolderTool(db, { job, chatId: chat.id }, u.name, u.input || {})) || "Nothing." }); }
          catch (e) { results.push({ type: "tool_result", tool_use_id: u.id, content: "Couldn't read it: " + String((e && e.message) || e).slice(0, 300), is_error: true }); }
        } else results.push({ type: "tool_result", tool_use_id: u.id, content: "Unknown tool.", is_error: true });
      }
      api = [...api, { role: "user", content: results }];
    }
    await save(db, chat.id, [], { api_messages: api, container_id: containerId, usage, turn_note: noteOf(res.content), ...(waiting !== undefined ? { waiting } : {}) });
    if (res.stop_reason === "pause_turn" || uses.length) continue;
    break;
  }

  // the files he saved this turn → the job (and from there to G)
  const turn = api.slice(start);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const files = [];
  for (const id of turnFileIds(turn)) {
    const meta = await anthropic.files.retrieveMetadata(id);
    const buf = Buffer.from(await (await anthropic.files.download(id)).arrayBuffer());
    const path = chatFilePath(job.id, chat.id, stamp, meta.filename);
    const up = await db.storage.from(BUCKET).upload(path, buf, { contentType: meta.mime_type || "application/octet-stream", upsert: false });
    if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new Error(`storing ${meta.filename}: ${up.error.message}`);
    const { data: row, error } = await db.from("panel_files").insert({ job_id: job.id, kind: "chat_output", role: null, name: meta.filename, mime: meta.mime_type || null, size_bytes: buf.length, sha256: sha(buf), storage_path: path, chat_id: chat.id, created_by: "Pete" }).select("id").maybeSingle();
    if (error && !/duplicate key/i.test(error.message)) throw new Error(`recording ${meta.filename}: ${error.message}`);
    files.push({ id: row ? row.id : null, name: meta.filename, storage_path: path, bytes: buf.length });
  }
  const reply = replyOf(turn) || (files.length ? "Saved." : "I didn't get to an answer - say that again?");
  // "Ran 16 commands" - the line Claude Desktop shows above a reply (Jed's screenshots, 2026-11-16)
  const ran = turn.reduce((n, m) => n + (m.role === "assistant" && Array.isArray(m.content) ? m.content.filter((b) => b && b.type === "server_tool_use").length : 0), 0);
  await save(db, chat.id, [{ role: "agent", text: reply, at: new Date().toISOString(), ...(ran ? { ran } : {}), ...(files.length ? { files } : {}) }], { api_messages: api, container_id: containerId, usage, ...(waiting !== undefined ? { waiting } : {}) }, "done");
  return { reply, files };
}

function addUsage(a = {}, u = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(u || {})) if (typeof v === "number") out[k] = (out[k] || 0) + v;
  return out;
}

/* An API error in plain words for the chat (Jed's first dev test, 2026-11-16, showed the raw 429 JSON twice): the
   API's own message from inside the JSON, and the usage-limit case said simply. */
export function plainError(e) {
  const raw = String((e && e.message) || e || "");
  let inner = (e && e.error && e.error.error && e.error.error.message) || null;
  if (!inner) { const j = raw.indexOf("{"); if (j >= 0) { try { const o = JSON.parse(raw.slice(j)); inner = (o.error && o.error.message) || o.message || null; } catch { /* not JSON */ } } }
  const text = inner || raw;
  const back = /regain access on (\d{4}-\d{2}-\d{2})/.exec(text);
  if (/usage limit|spend limit|usage threshold|enforced_spend_limit/i.test(raw + text)) {
    const d = back ? new Date(back[1] + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "long", timeZone: "UTC" }) : null;
    return `Anthropic's monthly API limit is reached${d ? ` - access comes back on ${d}` : ""}`;
  }
  if (/credit balance is too low/i.test(text)) return "the Anthropic account is out of API credit";
  if (/overloaded/i.test(text)) return "Anthropic is overloaded right now - try again in a minute";
  return text.slice(0, 400);
}

export async function processTurn(t, chat, anthropic, log = console) {
  try {
    return await runTurn(t, chat, anthropic, { log });
  } catch (e) {
    const msg = plainError(e);
    log.error(`[pete] ${t.name} chat ${chat.id}: ${String((e && e.message) || e).slice(0, 500)}`);
    await save(t.db, chat.id, [{ role: "event", text: `Pete stopped: ${msg}. Send a message to try again.`, at: new Date().toISOString() }], { turn_error: msg }, "failed").catch(() => {});
    return { failed: msg };
  }
}

export function startPeteWorker({ log = console, everyMs = 4000 } = {}) {
  if (process.env.PETE_WORKER !== "on") { log.log("[pete] worker off (set PETE_WORKER=on)"); return null; }
  const targets = peteTargets();
  const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const t of targets) {
        const { data, error } = await t.db.rpc("pete_claim_turn", { p_worker: WORKER_ID, p_lease_seconds: LEASE_S });
        if (error) { if (!/pete_claim_turn/.test(error.message)) log.error(`[pete] ${t.name} claim: ${error.message}`); continue; }
        const chat = Array.isArray(data) ? data[0] : data;
        if (!chat) continue;
        if (!anthropic) { await save(t.db, chat.id, [{ role: "event", text: "Pete can't run: ANTHROPIC_API_KEY is not set on the worker.", at: new Date().toISOString() }], { turn_error: "no API key" }, "failed").catch(() => {}); continue; }
        await processTurn(t, chat, anthropic, log);
      }
    } catch (e) { log.error("[pete] tick:", e && e.message); }
    busy = false;
  };
  const timer = setInterval(tick, everyMs);
  timer.unref && timer.unref();
  setTimeout(tick, 3000).unref();
  log.log(`[pete] worker ${WORKER_ID} on - ${targets.map((x) => x.name).join(" + ") || "no database"}`);
  return { tick };
}
