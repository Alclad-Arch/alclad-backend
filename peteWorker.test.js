// Pete rebuilt like Claude Desktop - the worker end to end with a stand-in database (pete_chats + the two SQL
// functions it calls, as 20261116_pete_desktop.sql does them) and a stand-in Claude. What matters: the new messages go
// to Claude as one turn with names, pictures and sheets; the container is kept between turns; a long turn
// (pause_turn) is saved after every call; files he saves land on the job and in his reply; waiting_on parks the job;
// someone writing while he works is never lost; a container that ran out restarts with the job's files; a failure
// stops with the reason, and the next message picks the question up again.
import assert from "node:assert/strict";
import test from "node:test";
import { runTurn, processTurn, peteTargets, plainError } from "./peteWorker.js";
import { userTurn, withUserTurn, peteSystem, replyOf, noteOf, chatFilePath, WAITING_TOOL } from "./peteTurn.js";

process.env.PANEL_SKILL_ID = "skill_test";
const quiet = { log() {}, error() {} };
const clone = (v) => JSON.parse(JSON.stringify(v));

function fakeDb(seed) {
  const T = clone(seed.tables);
  const files = new Map(Object.entries(seed.storage || {}));
  const saves = [];
  const q = (table) => {
    const rows = () => T[table] || (T[table] = []);
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
          if (ins) { const made = ins.map((r) => { const row = { id: "f" + rows().length, ...r }; rows().push(row); return row; }); return res({ data: one ? made[0] : made, error: null }); }
          const hit = rows().filter((r) => f.every((fn) => fn(r)));
          if (patch) { hit.forEach((r) => Object.assign(r, clone(patch))); return res({ data: hit, error: null }); }
          if (one) return res({ data: hit[0] || null, error: one === "single" && !hit[0] ? { message: "none" } : null });
          return res({ data: hit, error: null });
        } catch (e) { rej(e); }
      },
    };
    return api;
  };
  return {
    T, files, saves,
    from: q,
    // pete_worker_save as the SQL does it: append, set, status (done → queued again when someone wrote meanwhile)
    async rpc(name, a) {
      if (name !== "pete_worker_save") return { data: null, error: { message: "unknown rpc " + name } };
      const c = T.pete_chats.find((x) => x.id === a.p_chat);
      saves.push(clone(a));
      c.messages = [...c.messages, ...clone(a.p_append || [])];
      for (const k of ["api_messages", "api_upto", "container_id", "usage", "uploads", "turn_note", "waiting"]) if (a.p_set && k in a.p_set) c[k] = clone(a.p_set[k]);
      if (a.p_status === "failed") { c.turn_status = "failed"; c.turn_error = a.p_set.turn_error; }
      if (a.p_status === "done") c.turn_status = c.messages.slice(c.api_upto).some((m) => m.role === "user") ? "queued" : "idle";
      return { data: c, error: null };
    },
    storage: { from: () => ({
      async upload(p, buf) { if (files.has(p)) return { error: { message: "The resource already exists" } }; files.set(p, Buffer.from(buf)); return { error: null }; },
      async download(p) { const b = files.get(p); return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: "not found " + p } }; },
    }) },
  };
}

function fakeClaude(turns, { throwAt = {}, out = {} } = {}) {
  let n = 0; const uploads = []; const calls = [];
  return {
    calls, uploads,
    files: {
      async upload({ file }) { uploads.push(file.name); return { id: "up" + uploads.length }; },
      async retrieveMetadata(id) { return { id, filename: out[id].filename, mime_type: out[id].mime || "application/dxf" }; },
      async download(id) { return new Response(out[id].body); },
    },
    beta: { messages: { stream(body) {
      calls.push(clone(body)); const i = n++;
      return { async finalMessage() { if (throwAt[i]) throw new Error(throwAt[i]); return turns[i]; } };
    } } },
  };
}
const res = (ids) => ({ type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_result", content: ids.map((id) => ({ type: "bash_code_execution_output", file_id: id })) } });
const ran = (command) => ({ type: "server_tool_use", name: "bash_code_execution", input: { command } });
const ABH = "u-abhey";
const seed = (chat = {}) => ({
  tables: {
    panel_jobs: [{ id: "pj_1", name: "6163 Hale Oakleigh South", settings: { material: "4mm Vitracore G2" }, rules: [], existing_spec: { panels: [] }, running_total_m2: 0, offcuts: [], current_main_file_id: null }],
    panel_files: [{ id: "s1", job_id: "pj_1", kind: "sheet", name: "OF2 South.pdf", mime: "application/pdf", storage_path: "pj_1/sheets/s1.pdf" }],
    panel_sets: [],
    pete_chats: [{ id: "c1-0000-0000", job_id: "pj_1", turn_status: "running", api_messages: [], api_upto: 0, container_id: null, usage: {}, uploads: {}, waiting: null,
      messages: [{ role: "user", text: "Draft the OF2 South sheets", by: "Abhey", by_id: ABH, images: [`${ABH}/1-0.png`], sheets: ["s1"] }], ...chat }],
  },
  storage: { "pj_1/sheets/s1.pdf": Buffer.from("PDF"), [`${ABH}/1-0.png`]: Buffer.from("PNG") },
});
const OUT = { fp: { filename: "6163 Hale Oakleigh South - Set 1 - Panel preview.dxf", body: "DXF" }, fq: { filename: "6163 Hale Oakleigh South - Set 1 - Panel preview.pdf", body: "PDF", mime: "application/pdf" } };

test("a turn: their words with names, pictures and sheets; the job's files in a new container; files saved go on the job and in his reply", async () => {
  const db = fakeDb(seed());
  const claude = fakeClaude([
    { stop_reason: "pause_turn", container: { id: "cntr_1" }, usage: { input_tokens: 100 }, content: [ran("python draft.py"), { type: "text", text: "Reading the sheets" }] },
    { stop_reason: "end_turn", container: { id: "cntr_1" }, usage: { input_tokens: 50 }, content: [ran("cp *.dxf *.pdf $OUTPUT_DIR"), res(["fp", "fq"]), { type: "text", text: "Rev 1 is in Claude DXFs - 18 panels. Check P-12's return." }] },
  ], { out: OUT });
  const r = await runTurn({ name: "dev", db }, db.T.pete_chats[0], claude, { log: quiet, today: "Monday 16 November 2026" });
  const first = claude.calls[0];
  assert.deepEqual(first.messages[0].content.map((b) => b.type), ["container_upload", "image", "document", "container_upload", "text"]);
  assert.match(first.messages[0].content.at(-1).text, /^\[Abhey\] Draft the OF2 South sheets\n\(attached: 1 screenshot; sheets: OF2 South\.pdf\)/);
  assert.deepEqual(claude.uploads, ["1-0.png", "OF2 South.pdf", "job.json"]);       // pictures, sheets, then the job's file
  assert.deepEqual(first.tools.map((t) => t.name), ["code_execution", "waiting_on", "look_in_job_folder", "read_job_document", "check_files_on_g"]);
  assert.equal(first.container.skills[0].skill_id, "skill_test");
  assert.match(first.system, /6163 Hale Oakleigh South/); assert.match(first.system, /CORRECTIONS COME IN BATCHES/);
  assert.equal(claude.calls[1].container.id, "cntr_1");                               // the container is kept
  assert.equal(claude.calls[1].messages.length, 2);                                   // a pause is sent back as is
  const c = db.T.pete_chats[0];
  assert.equal(c.turn_status, "idle"); assert.equal(c.api_upto, 1); assert.equal(c.container_id, "cntr_1");
  const reply = c.messages.at(-1);
  assert.equal(reply.role, "agent"); assert.match(reply.text, /^Rev 1 is in Claude DXFs/);
  assert.equal(reply.ran, 2);                                                          // "Ran 2 commands", as Desktop shows
  assert.deepEqual(reply.files.map((f) => f.name), [OUT.fp.filename, OUT.fq.filename]);
  const kept = db.T.panel_files.filter((f) => f.kind === "chat_output");
  assert.equal(kept.length, 2); assert.ok(kept.every((f) => f.chat_id === "c1-0000-0000" && f.job_id === "pj_1" && /^pj_1\/chat\/c1-0000-\//.test(f.storage_path)));
  assert.ok(db.saves.length >= 3);                                                     // saved after every call
  assert.equal(r.files.length, 2);
});

test("the NEXT turn: only the new message, the same container, no job files again", async () => {
  const db = fakeDb(seed({ container_id: "cntr_1", api_upto: 2, uploads: { s1: { file_id: "upS", name: "OF2 South.pdf", mime: "application/pdf" } },
    api_messages: [{ role: "user", content: [{ type: "text", text: "[Abhey] Draft" }] }, { role: "assistant", content: [{ type: "text", text: "Rev 1 done" }] }],
    messages: [{ role: "user", text: "Draft", by: "Abhey" }, { role: "agent", text: "Rev 1 done" }, { role: "user", text: "P-12 return is 50", by: "Jed", by_id: "u-jed" }] }));
  const claude = fakeClaude([{ stop_reason: "end_turn", container: { id: "cntr_1" }, usage: {}, content: [{ type: "text", text: "Got it - P-12 return to 50. Anything else?" }] }]);
  await runTurn({ name: "dev", db }, db.T.pete_chats[0], claude, { log: quiet });
  const sent = claude.calls[0];
  assert.equal(sent.messages.length, 3); assert.equal(sent.container.id, "cntr_1");
  assert.deepEqual(sent.messages[2].content, [{ type: "text", text: "[Jed] P-12 return is 50" }]);
  assert.deepEqual(claude.uploads, []);                                                // nothing uploaded again
  assert.match(db.T.pete_chats[0].messages.at(-1).text, /Anything else\?/);
});

test("waiting_on parks the job, is answered, and the turn carries on", async () => {
  const db = fakeDb(seed());
  const claude = fakeClaude([
    { stop_reason: "tool_use", container: { id: "cntr_1" }, usage: {}, content: [{ type: "tool_use", id: "tu1", name: "waiting_on", input: { note: "site: P-12 return depth" } }] },
    { stop_reason: "end_turn", container: { id: "cntr_1" }, usage: {}, content: [{ type: "text", text: "Parked until site comes back on P-12." }] },
  ]);
  await runTurn({ name: "dev", db }, db.T.pete_chats[0], claude, { log: quiet });
  assert.deepEqual(claude.calls[1].messages.at(-1).content, [{ type: "tool_result", tool_use_id: "tu1", content: 'Parked: the job shows "Waiting on site: P-12 return depth".' }]);
  assert.equal(db.T.pete_chats[0].waiting, "site: P-12 return depth");
});

test("someone writes while he works: nothing lost - the turn goes back to queued for them", async () => {
  const db = fakeDb(seed());
  const claude = fakeClaude([{ stop_reason: "end_turn", container: { id: "cntr_1" }, usage: {}, content: [{ type: "text", text: "Drawing it" }] }]);
  const orig = claude.beta.messages.stream;
  claude.beta.messages.stream = (b) => { db.T.pete_chats[0].messages.push({ role: "user", text: "also flip P-07", by: "Jed" }); return orig(b); };
  await runTurn({ name: "dev", db }, db.T.pete_chats[0], claude, { log: quiet });
  const c = db.T.pete_chats[0];
  assert.deepEqual(c.messages.map((m) => m.text), ["Draft the OF2 South sheets", "also flip P-07", "Drawing it"]);
  assert.equal(c.turn_status, "queued");
});

test("the container ran out: a new one, with the job's files uploaded again", async () => {
  const db = fakeDb(seed({ container_id: "cntr_old" }));
  const claude = fakeClaude([null, { stop_reason: "end_turn", container: { id: "cntr_new" }, usage: {}, content: [{ type: "text", text: "Back" }] }], { throwAt: { 0: "container cntr_old has expired" } });
  await runTurn({ name: "dev", db }, db.T.pete_chats[0], claude, { log: quiet });
  assert.equal(claude.calls[1].container.id, undefined);
  assert.ok(claude.calls[1].messages.at(-1).content.some((b) => b.type === "text" && /container was restarted/.test(b.text)));
  assert.ok(claude.uploads.includes("job.json"));
  assert.equal(db.T.pete_chats[0].container_id, "cntr_new");
});

test("a failure stops with the reason; the next message picks the same question up again", async () => {
  const db = fakeDb(seed());
  const r = await processTurn({ name: "dev", db }, db.T.pete_chats[0], fakeClaude([null], { throwAt: { 0: "Your credit balance is too low" } }), quiet);
  const c = db.T.pete_chats[0];
  assert.match(r.failed, /out of API credit/); assert.equal(c.turn_status, "failed");
  assert.match(c.messages.at(-1).text, /^Pete stopped: the Anthropic account is out of API credit/);
  c.messages.push({ role: "user", text: "try again", by: "Abhey" }); c.turn_status = "running";
  const claude = fakeClaude([{ stop_reason: "end_turn", container: { id: "cntr_1" }, usage: {}, content: [{ type: "text", text: "On it" }] }]);
  await runTurn({ name: "dev", db }, c, claude, { log: quiet });
  const sent = claude.calls[0].messages;
  assert.equal(sent.length, 1);                                                        // ONE user turn, never two in a row
  assert.ok(sent[0].content.some((b) => b.type === "text" && /Draft the OF2 South/.test(b.text)) && sent[0].content.some((b) => b.type === "text" && /try again/.test(b.text)));
});

test("API errors in plain words (Jed's first dev test: the raw 429 JSON)", () => {
  const raw = '429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization API tier. You will regain access on 2026-12-01 at 00:00 UTC.","details":{"error_code":"enforced_spend_limit_reached"}},"request_id":"req_1"}';
  assert.equal(plainError(new Error(raw)), "Anthropic's monthly API limit is reached - access comes back on 1 December");
  assert.equal(plainError(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}')), "the Anthropic account is out of API credit");
  assert.equal(plainError(new Error("socket hang up")), "socket hang up");
});

test("pure parts: who he works for, what he's doing, where files go; targets default to dev only", () => {
  assert.match(peteSystem({ job: { name: "6163" }, waiting: "site: P-12" }), /PARKED, waiting on: site: P-12/);
  assert.match(peteSystem({ job: { name: "6163" } }), /3mm solid YES, 4mm ACM\/NCP NO/);
  assert.equal(noteOf([ran("python release.py && cp x $OUTPUT_DIR")]), "Saving the files…");
  assert.equal(noteOf([{ type: "text", text: "hm" }]), "Thinking…");
  assert.equal(replyOf([{ role: "assistant", content: [{ type: "text", text: "a" }] }, { role: "assistant", content: [{ type: "text", text: "b" }] }]), "b");
  assert.equal(chatFilePath("pj_1", "c1-0000-0000-1", "2026", "a/b.dxf"), "pj_1/chat/c1-0000-/2026/a_b.dxf");
  assert.deepEqual(withUserTurn([{ role: "assistant", content: [] }], [{ type: "text", text: "x" }]).map((m) => m.role), ["assistant", "user"]);
  assert.equal(userTurn([{ role: "agent", text: "no" }]).length, 0);
  assert.equal(WAITING_TOOL.name, "waiting_on");
  assert.deepEqual(peteTargets({ PANEL_DEV_SUPABASE_URL: "https://x.supabase.co", PANEL_DEV_SERVICE_ROLE_KEY: "k", SUPABASE_URL: "https://y.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }).map((t) => t.name), ["dev"]);
});

test("a folder tool in a turn: run on the job, answered, and the turn carries on", async () => {
  const db = fakeDb(seed());
  const claude = fakeClaude([
    { stop_reason: "tool_use", container: { id: "cntr_1" }, usage: {}, content: [{ type: "tool_use", id: "tu1", name: "look_in_job_folder", input: { folder: "claude_dxfs" } }] },
    { stop_reason: "end_turn", container: { id: "cntr_1" }, usage: {}, content: [{ type: "text", text: "The job isn't linked to a G folder yet." }] },
  ]);
  await runTurn({ name: "dev", db }, db.T.pete_chats[0], claude, { log: quiet });
  const res = claude.calls[1].messages.at(-1).content[0];
  assert.equal(res.type, "tool_result"); assert.equal(res.tool_use_id, "tu1");
  assert.match(res.content, /isn't linked to a hub project/);                      // the seeded job has no hub project
  assert.match(db.T.pete_chats[0].messages.at(-1).text, /isn't linked/);
});
