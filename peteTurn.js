// PETE, REBUILT LIKE CLAUDE DESKTOP — the pure half (no network): what one turn sends to Claude, and how the answer is
// read. Jed 2026-11-16: "strip it back to bare bones … purely the chat so we start from a Claude Desktop like
// situation". One Claude per panel job, in ONE conversation (the job's shared chat, alclad.app pete_chats), with the
// alclad-panel-drafting skill and code execution, the container kept between turns — as Desktop keeps its session.
// The worker (peteWorker.js) does the I/O. Same API shape as the drafter runs (panelRun.js).
import { PANEL_BETAS, CODE_TOOL, outputGroups } from "./panelRun.js";
import { FOLDER_TOOLS } from "./peteFolder.js";

export const PETE_MODEL = () => process.env.PETE_MODEL || process.env.PANEL_MODEL || "claude-opus-5-5";
export const PETE_MAX_CALLS = 40;            // rounds (pause_turn / tool use) in one turn before it's called stuck
export const PETE_LEASE_MS = 10 * 60 * 1000;
export const G_DXF = "7. Drawings\\7. Cladding\\1. Fab Drawings\\Claude DXFs";
export const G_PDF = "7. Drawings\\7. Cladding\\4. Layout Drawings";

// his one tool besides code execution: park the job waiting on something outside the chat (and clear it)
export const WAITING_TOOL = {
  name: "waiting_on",
  description: "Park this job as WAITING ON something outside the chat - an answer from site, the builder, the architect, a supplier. The job then shows as waiting in the app until it comes in. Call it with a few words naming it when an answer has to come from outside; call it with an empty note to CLEAR it as soon as the answer arrives.",
  input_schema: { type: "object", properties: { note: { type: "string", description: 'What it waits on, short: "site: P-12 return depth". Empty = not waiting any more.' } }, required: ["note"] },
};

/* How Pete works — Claude Desktop's panel drafting, in the app (Jed's agreed flow, 2026-11-16). The skill holds the
   drafting itself; this is the working arrangement around it. */
export function peteSystem({ job, people = "Abhey, and Jed when he jumps in to help", waiting = null, today = "" } = {}) {
  return [
    "You are Pete, Alclad's panel draftie. You draft aluminium cladding panels from site measure sheets with the alclad-panel-drafting skill, exactly as it is used in Claude Desktop - read the skill and follow it.",
    `This conversation is the shared chat for ONE panel job${job ? `: "${job.name}"` : ""}. ${people} read it and add to it; each of their messages starts with [their name]. Talk to whoever just spoke.${today ? ` Today is ${today}.` : ""}`,
    "",
    "HOW THE JOB GOES (as in Claude Desktop):",
    "1. Read the sheets and drawings they give you (attached here). Settings come from the drawings: material and colour from the shop drawings; sheet sizes from job.json (the project's stock); pre-drilled follows the material - 3mm solid YES, 4mm ACM/NCP NO. Ask in the chat only for what you can't find.",
    "2. Ask your questions in the chat, plainly - a few at a time at most. If an answer has to come from site (or anyone outside the chat), park the job with waiting_on and say so.",
    "3. Make the panel preview DXF and PDF and SAVE them (below). Tell them in a few lines what you drew and anything to check - they review by opening the DXF.",
    "4. CORRECTIONS COME IN BATCHES: when they send a change (typed, or a marked-up screenshot), say back what you'll do and ask \"anything else?\" - keep a running list. Do NOT redraw until they say that's everything (\"go\", \"that's all\", \"redraw\"). Then redraw once with the whole list and say what changed.",
    "5. When they say GO AHEAD: make the production files - machining (one per sheet size and colour, each with its .nest.json), the Z-angle calc, and the Main Drawing File updated with this set - SAVE them, and finish with a short summary: panels, sheets used per size and colour, m2, and anything still open.",
    "",
    "SAVING FILES: a file is saved by copying it into $OUTPUT_DIR inside the same code-execution command that makes it. Every file saved there is kept on the job, and goes to the job's folder on G by itself:",
    `- DXF, XLSX/CSV and .nest.json files -> ${G_DXF}`,
    `- PDF files -> ${G_PDF}`,
    "Save only finished drawings and production files, named exactly as the skill names them (the same name UPDATES that file on G - the Main Drawing File is one per project). Never save scratch files, json working files or pictures there.",
    "",
    "THE JOB'S FILES: job.json (settings, stock sheet sizes, panels already drawn in earlier sets, offcuts) and the current Main Drawing File (if there is one) are uploaded into your container at the start. Earlier turns' files stay in the container while it lasts; if one has gone, say so and rebuild it from the spec.",
    "",
    "THE JOB'S FOLDER ON G - you can LOOK, not touch: look_in_job_folder lists what's there (Claude DXFs, Layout Drawings, the whole job), read_job_document reads a PDF/Word/Excel file's text, check_files_on_g says whether your saved files reached G (or were kept beside a hand-edited copy). Look before you save (what's there now, old versions to warn about) and check after - only then say the files are in Claude DXFs. You cannot delete, move or edit anything on G: if something should go, list it for them to delete.",
    "Never say a file is saved unless you copied it to $OUTPUT_DIR. Write like a draftie in a chat - short, plain, no headings.",
    waiting ? `\nThis job is PARKED, waiting on: ${waiting}. If the latest message answers it, clear it (waiting_on with an empty note) and carry on.` : "",
  ].join("\n");
}

/* The new messages from people since Claude was last given the chat (chat.messages from api_upto on), as ONE user
   turn: each person's words with their name, their screenshots to look at, their sheets to read (and in the
   container for the scripts), and - on the first turn of a container - the job's own files. `ids` maps a picture's
   storage path / a sheet's file row id to the Files API id it was uploaded as. */
export function userTurn(newMessages, ids = {}, jobUploads = []) {
  const blocks = [];
  for (const id of jobUploads) blocks.push({ type: "container_upload", file_id: id });
  for (const m of newMessages || []) {
    if (!m || m.role !== "user") continue;
    for (const p of m.images || []) if (ids[p]) blocks.push({ type: "image", source: { type: "file", file_id: ids[p].file_id } });
    for (const s of m.sheets || []) {
      const f = ids[s];
      if (!f) continue;
      blocks.push(f.mime === "application/pdf" ? { type: "document", source: { type: "file", file_id: f.file_id }, title: f.name } : { type: "image", source: { type: "file", file_id: f.file_id } });
      blocks.push({ type: "container_upload", file_id: f.file_id });
    }
    const said = String(m.text || "").trim();
    const att = [(m.images || []).length ? `${m.images.length} screenshot${m.images.length === 1 ? "" : "s"}` : "", (m.sheets || []).length ? `sheets: ${(m.sheets || []).map((s) => (ids[s] && ids[s].name) || "sheet").join(", ")}` : ""].filter(Boolean).join("; ");
    blocks.push({ type: "text", text: `[${m.by || "someone"}] ${said || "(no words)"}${att ? `\n(attached: ${att})` : ""}` });
  }
  return blocks;
}

// add a user turn to Claude's conversation - into the last user message if it never got an answer (a failed turn)
export function withUserTurn(apiMessages, blocks) {
  const msgs = Array.isArray(apiMessages) ? [...apiMessages] : [];
  const last = msgs[msgs.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content) && !last.content.some((b) => b && b.type === "tool_result")) {
    msgs[msgs.length - 1] = { ...last, content: [...last.content, ...blocks] };
  } else msgs.push({ role: "user", content: blocks });
  return msgs;
}

// one call's request - the same every round; only messages and the container move on
export function peteRequest({ messages, containerId, skillId, system, model = PETE_MODEL() }) {
  return {
    model, max_tokens: 32000, betas: PANEL_BETAS, system,
    container: { ...(containerId ? { id: containerId } : {}), skills: [{ type: "custom", skill_id: skillId, version: "latest" }] },
    tools: [CODE_TOOL, WAITING_TOOL, ...FOLDER_TOOLS],
    messages,
  };
}

// his words for the chat: the text of the assistant messages in this turn, after the last tool round
export function replyOf(turnMessages) {
  const said = [];
  for (const m of turnMessages || []) {
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const t = m.content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
    if (t) said.push(t);
  }
  return said.length ? said[said.length - 1] : "";
}

// what he's doing right now, for the chat's status line - from the last thing he ran
export function noteOf(content) {
  for (const b of [...(content || [])].reverse()) {
    if (b && b.type === "server_tool_use" && b.input) {
      const cmd = String(b.input.command || b.input.code || "");
      if (/publish|OUTPUT_DIR/.test(cmd)) return "Saving the files…";
      if (/release|nest|machining/i.test(cmd)) return "Nesting and making the production files…";
      if (/draft|panelgen|generator/i.test(cmd)) return "Drawing the panels…";
      return "Working on it…";
    }
  }
  return "Thinking…";
}

// the files he saved this turn (Files API ids, in order, each once)
export const turnFileIds = (turnMessages) => [...new Set(outputGroups(turnMessages).flat())];

// where a saved file is kept in the bucket - one folder per turn, never over anything
export function chatFilePath(jobId, chatId, stamp, name) {
  const safe = String(name || "file").replace(/[\\/]+/g, "_").replace(/[^\w .()+&,-]/g, "_").slice(0, 180);
  return `${jobId}/chat/${String(chatId).slice(0, 8)}/${stamp}/${safe}`;
}
