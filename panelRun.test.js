// Panel drafting runs — panelRun.js.
import assert from "node:assert/strict";
import test from "node:test";
import { taskText, jobJson, firstContent, requestBody, outputGroups, finalText, outputPath, roleOf, addUsage, CODE_TOOL, PANEL_BETAS } from "./panelRun.js";

test("task text per mode, as the contract words it", () => {
  assert.equal(taskText("draft", { sheetNames: ["IMG_0412.jpg", "North.pdf"] }), "New draft. Job: job.json. Sheets attached: IMG_0412.jpg, North.pdf. Draft them with the alclad-panel-drafting skill.");
  assert.match(taskText("redraw", { draftName: "6197 Croydon", rev: 2, sheetNames: ["a.jpg"] }), /^Redraw\. Previous reading: reading\.json\. Answers: answers\.json .* rev 2/);
  assert.equal(taskText("release", { setNo: 2, setLabel: "South", date: "2026-10-30" }),
    'Release the approved draft. Spec: spec.json. Set 2 "South", date 2026-10-30. Main Drawing File: none - first set. Offcuts: offcuts.json. Ordered layout: none.');
  assert.throws(() => taskText("approve"), /Unknown run mode/);
});

test("job.json from the job row: settings carry the job name; sets and totals as numbers", () => {
  const j = jobJson({ name: "6197 Storage King Croydon", settings: { colour: "White", predrill: true }, settings_confirmed: true, rules: ["JOB: 80 jambs raw"], running_total_m2: "162.4" },
    [{ no: 1, label: "North", set_m2: "162.4", status: "cut" }]);
  assert.equal(j.settings.job, "6197 Storage King Croydon");
  assert.equal(j.settings.colour, "White");
  assert.deepEqual(j.existing_spec, { panels: [] });
  assert.deepEqual(j.sets, [{ no: 1, label: "North", m2: 162.4, status: "cut" }]);
  assert.equal(j.running_total_m2, 162.4);
});

test("a batch's sheet view (chosen at Draft these) is what the drafter is told; nonsense is ignored", () => {
  const job = { name: "6197", settings: { sheet_view: "rear", colour: "White" } };
  assert.equal(jobJson(job, [], { sheet_view: "front" }).settings.sheet_view, "front");
  assert.equal(jobJson(job, [], {}).settings.sheet_view, "rear");
  assert.equal(jobJson(job, [], { sheet_view: "sideways" }).settings.sheet_view, "rear");
  assert.equal(jobJson(job, [], { sheet_view: "front" }).settings.colour, "White");
});

test("the first message: sheets SEEN (image / document), files for the scripts, then the task", () => {
  const c = firstContent({ sheets: [{ fileId: "f1", mime: "image/jpeg", name: "a.jpg" }, { fileId: "f2", mime: "application/pdf", name: "b.pdf" }], uploads: ["j1"], text: "go" });
  assert.deepEqual(c.map((b) => b.type), ["image", "document", "container_upload", "text"]);
  assert.equal(c[1].source.file_id, "f2");
});

test("the request: today's code-execution tool and beta flag, the skill in the container, the container reused", () => {
  const r = requestBody({ messages: [], containerId: "cntr_1", skillId: "skill_abc", model: "claude-opus-5-5" });
  assert.deepEqual(r.tools, [{ type: "code_execution_20260521", name: "code_execution" }]);
  assert.deepEqual(r.betas, ["code-execution-2025-08-25"]);
  assert.deepEqual(r.container, { id: "cntr_1", skills: [{ type: "custom", skill_id: "skill_abc", version: "latest" }] });
  assert.equal(requestBody({ messages: [], skillId: "s" }).container.id, undefined);
  assert.equal(CODE_TOOL.name, "code_execution"); assert.equal(PANEL_BETAS.length, 1);
});

test("output files per call, in order — the worker takes the last group with manifest.json", () => {
  const res = (ids) => ({ type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_result", content: ids.map((id) => ({ type: "bash_code_execution_output", file_id: id })) } });
  const msgs = [{ role: "user", content: [] }, { role: "assistant", content: [{ type: "text", text: "drawing" }, res(["p1", "p2"])] },
    { role: "assistant", content: [res([]), { type: "text", text: "Status: awaiting review. 3 questions." }, res(["m1", "m2", "m3"])] }];
  assert.deepEqual(outputGroups(msgs), [["p1", "p2"], ["m1", "m2", "m3"]]);
  assert.equal(finalText(msgs), "Status: awaiting review. 3 questions.");
  assert.deepEqual(outputGroups([{ role: "user", content: [res(["x"])] }]), []);   // only Claude's calls count
});

test("a returned file's place and role — never a path that climbs out", () => {
  assert.equal(outputPath("pj_1", "d1", "6197 Croydon - Panel preview.pdf"), "pj_1/drafts/d1/6197 Croydon - Panel preview.pdf");
  assert.equal(outputPath("pj_1", "d1", "../../x/../y.dxf"), "pj_1/drafts/d1/.._.._x_.._y.dxf");
  const man = { kind: "draft", files: [{ name: "review.json", role: "review" }, { name: "a - Machining.dxf", role: "machining" }] };
  assert.equal(roleOf(man, "review.json"), "review");
  assert.equal(roleOf(man, "preview-r1-c2.png"), "preview_image");
  assert.equal(roleOf(man, "unknown.txt"), null);
});

test("token use adds up across calls", () => {
  const t = addUsage(addUsage(null, { input_tokens: 10, output_tokens: 5 }), { input_tokens: 3, cache_read_input_tokens: 7 });
  assert.deepEqual(t, { input_tokens: 13, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 0, calls: 2 });
});
