import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dispatcher = join(here, "..", "scripts", "aicowork-yue.mjs");
const KEY = "yue_test-key-123456789";

/**
 * In-memory YuE Studio. State lives on globalThis inside the spawned
 * dispatcher process, so one fixture serves submit → poll → download.
 *   CHECK  — JS expression `(body, headers) => string|null`; non-null → 422
 *   FINAL  — "completed" | "failed" | "hang"
 */
const SERVER = String.raw`
const json = (status, obj) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });
const text = (s) => ({ ok: true, status: 200, text: async () => s, arrayBuffer: async () => { const b = Buffer.from(s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
const bytes = (tag) => { const b = Buffer.from(tag); return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), text: async () => tag }; };
const state = globalThis.__yue ??= { jobs: {}, polls: {}, n: 0, idem: {}, uploads: [] };
const check = CHECK;
const FINAL = __FINAL__;
const ABC = "X:1\nT:test\nM:4/4\nL:1/8\nK:D\nV:Vocal\nD2 F2 A2 d2|\nV:Ins\nD,4 A,4|";
function mkJob(id, status, req, extra = {}) {
  const s = Object.assign({ caption: "", lyrics: "", cot: "full", abc: "", stage: "audio", seed: "831001", randomize_seed: true, instrumental_lora: false, cfg_scale: 1, ode_steps: 32, quantization: "none", offload_ar: false, vae_core_frames: 1024, backend: "torch", format: "flac", semantic_max_tokens: 9000, semantic_min_tokens: 200 }, req.settings || {});
  if (req.preset === "draft" && !(req.settings && req.settings.ode_steps)) s.ode_steps = 16;
  const plan = s.stage === "plan";
  const done = status === "completed";
  const outputs = done && !plan ? [{ index: 0, audio_url: "/api/v1/jobs/" + id + "/audio?index=0", duration_seconds: 47.3 }] : [];
  return { id, user_id: "u1", title: req.title || "새 곡", status, progress: status === "running" ? 0.4 : done ? 1 : 0, stage: status === "running" ? "합성 중" : status, created_at: "2026-09-19T11:00:00", completed_at: done ? "2026-09-19T11:03:00" : null, duration_seconds: done && !plan ? 47.3 : null, elapsed_seconds: done ? 130.5 : null, error: null, source: "api", favorite: false, settings: s, settings_reusable: true, workflow_url: "/api/v1/jobs/" + id + "/workflow", outputs, audio_url: outputs[0] ? outputs[0].audio_url : null, score_url: done && s.cot !== "off" ? "/api/v1/jobs/" + id + "/score" : null, artifacts_url: "/api/v1/jobs/" + id + "/artifacts", warning: null, source_plan_id: req.source_plan_id || null, exact_plan_reusable: done && !plan && s.cot !== "off", kind: "creation", bundle_url: done ? "/api/v1/jobs/" + id + "/bundle" : null, ...extra };
}
function mkTranscription(id, status) {
  const done = status === "completed";
  return { id, user_id: "u1", title: "Cover score · src", status, progress: done ? 1 : 0.5, stage: done ? "completed" : "채보 중", created_at: "2026-09-19T11:00:00", completed_at: done ? "2026-09-19T11:01:00" : null, duration_seconds: null, elapsed_seconds: done ? 40 : null, error: null, source: "api", favorite: false, settings: {}, settings_reusable: false, workflow_url: "", outputs: [], audio_url: null, score_url: done ? "/api/v1/jobs/" + id + "/score" : null, kind: "transcription", exact_plan_reusable: false, source_audio: { name: "src.flac", duration_seconds: 12.5, melody_only: true }, source_audio_url: "/api/v1/jobs/" + id + "/source-audio", transcription: done ? { method: "sheetsage2", source_duration_seconds: 12.5, warnings: ["tempo estimated at 92 BPM"] } : null };
}
export async function fixtureFetch(url, init = {}) {
  const u = new URL(url); const h = init.headers || {}; const m = (init.method || "GET").toUpperCase();
  if (h["Authorization"] !== "Bearer yue_test-key-123456789") return json(401, { detail: "API 키가 없거나 만료·폐기·계정 비활성화됨" });
  if (h["User-Agent"] !== "YuEStudioClient/1.0") return json(403, { detail: "blocked" });

  if (u.pathname === "/api/v1/jobs" && m === "POST") {
    const body = JSON.parse(init.body);
    const idem = h["Idempotency-Key"];
    if (!idem) return json(422, { detail: "Idempotency-Key header missing" });
    const problem = check(body, h); if (problem) return json(422, { detail: problem });
    if (state.idem[idem]) { const prev = state.idem[idem]; if (prev.body !== init.body) return json(409, { detail: "Idempotency-Key 요청 내용 충돌" }); return json(202, mkJob(prev.id, "queued", body)); }
    const id = "job" + (++state.n); state.jobs[id] = body; state.polls[id] = 0; state.idem[idem] = { id, body: init.body };
    return json(202, mkJob(id, "queued", body));
  }
  if (u.pathname === "/api/v1/covers/transcribe" && m === "POST") {
    if (h["Idempotency-Key"]) return json(422, { detail: "unexpected Idempotency-Key on upload" });
    if (h["Content-Type"] !== "application/octet-stream") return json(422, { detail: "expected octet-stream" });
    if (!u.searchParams.get("filename")) return json(422, { detail: "filename required" });
    const len = init.body ? init.body.length : 0;
    state.uploads.push({ filename: u.searchParams.get("filename"), title: u.searchParams.get("title"), melody_only: u.searchParams.get("melody_only"), len });
    state.jobs["tr1"] = { transcription: true }; state.polls["tr1"] = 0;
    return json(202, mkTranscription("tr1", "queued"));
  }
  if (u.pathname === "/api/v1/jobs" && m === "GET") {
    const items = [mkJob("done1", "completed", { title: "오늘의 노래", settings: { cot: "full", format: "mp3", semantic_max_tokens: 4500, caption: "c", lyrics: "[verse]\nla" } }, { favorite: true, warning: "음악 토큰 상한에 도달했습니다." }), mkTranscription("tr9", "completed"), mkJob("run1", "running", { title: "진행중" })];
    const st = u.searchParams.get("status"); const q = u.searchParams.get("q");
    return json(200, { items: items.filter(j => (!st || j.status === st) && (!q || j.title.includes(q))) });
  }
  let mm;
  if ((mm = u.pathname.match(/^\/api\/v1\/jobs\/(job\d+|tr1)$/)) && m === "GET") {
    const id = mm[1]; const req = state.jobs[id]; if (!req) return json(404, { detail: "not found" });
    const p = ++state.polls[id];
    const mk = (st) => id === "tr1" ? mkTranscription(id, st) : mkJob(id, st, req);
    if (FINAL === "hang") return json(200, mk("running"));
    if (p === 1) return json(200, mk("queued"));
    if (p === 2) return json(200, mk("running"));
    if (FINAL === "failed") return json(200, Object.assign(mk("failed"), { error: "CUDA out of memory" }));
    return json(200, mk("completed"));
  }
  if ((mm = u.pathname.match(/^\/api\/v1\/jobs\/([A-Za-z0-9]+)\/audio$/)) && m === "GET") {
    if (u.searchParams.get("download") !== "true") return json(422, { detail: "expected download=true" });
    return bytes("fLaC-" + mm[1]);
  }
  if ((mm = u.pathname.match(/^\/api\/v1\/jobs\/([A-Za-z0-9]+)\/artifacts\/score\.abc$/)) && m === "GET") return text(ABC + "\n%" + mm[1]);
  if ((mm = u.pathname.match(/^\/api\/v1\/jobs\/([A-Za-z0-9]+)\/artifacts\/(request|config|result)\.json$/)) && m === "GET") return text(JSON.stringify({ job: mm[1], artifact: mm[2] }));
  if ((mm = u.pathname.match(/^\/api\/v1\/jobs\/([A-Za-z0-9]+)\/source-audio$/)) && m === "GET") return bytes("RIFF-" + mm[1]);
  if ((mm = u.pathname.match(/^\/api\/v1\/jobs\/([A-Za-z0-9]+)\/bundle$/)) && m === "GET") return bytes("PK-" + mm[1]);
  if (u.pathname === "/api/v1/jobs/done1" && m === "GET") return json(200, mkJob("done1", "completed", { title: "오늘의 노래", settings: { cot: "full", format: "mp3", semantic_max_tokens: 4500, seed: "831001", randomize_seed: false, caption: "Warm folk", lyrics: "[verse]\nla" } }, { warning: "음악 토큰 상한에 도달했습니다." }));
  if (u.pathname === "/api/v1/jobs/plan1" && m === "GET") return json(200, mkJob("plan1", "completed", { title: "악보만", settings: { stage: "plan", cot: "melody" } }));
  if (u.pathname === "/api/v1/jobs/off1" && m === "GET") return json(200, mkJob("off1", "completed", { title: "off", settings: { cot: "off" } }));
  if (u.pathname === "/api/v1/jobs/tr9" && m === "GET") return json(200, mkTranscription("tr9", "completed"));
  if (u.pathname === "/api/v1/jobs/done1" && m === "PATCH") { const b = JSON.parse(init.body); return json(200, mkJob("done1", "completed", { title: b.title || "오늘의 노래" }, { favorite: !!b.favorite })); }
  if (u.pathname === "/api/v1/jobs/done1" && m === "DELETE") return json(200, { ok: true });
  if (u.pathname === "/api/v1/jobs/run1/cancel" && m === "POST") return json(200, mkJob("run1", "cancelled", { title: "진행중" }));
  if (u.pathname === "/api/v1/jobs/done1/workflow" && m === "GET") return json(200, { title: "오늘의 노래", settings: { seed: "831001", randomize_seed: false } });
  if (u.pathname === "/api/v1/score-tools/inspect" && m === "POST") { const b = JSON.parse(init.body); return json(200, { bpm: 92, unit_length: "1/8", nominal_duration_seconds: 12.4, voices: [{ name: "Vocal", notes: 4, bars: 1 }, { name: "Ins", notes: 2, bars: 1 }], abc_length: b.abc.length }); }
  if (u.pathname === "/api/v1/score-tools/strip-chords" && m === "POST") { const b = JSON.parse(init.body); return json(200, { abc: b.abc.replace(/"[^"]*"/g, ""), inspection: { bpm: 92 }, invariants: { keep_voice: b.keep_voice, chords_removed: 2 } }); }
  if (u.pathname === "/api/v1/score-tools/compare" && m === "POST") { const b = JSON.parse(init.body); return json(200, { match: b.before === b.after, compared_voices: b.voices || ["Vocal", "Ins"], differences: b.before === b.after ? [] : [{ voice: "Vocal", bar: 1, kind: "pitch" }] }); }
  if (u.pathname === "/api/v1/me" && m === "GET") return json(200, { id: "u1", username: "tester", display_name: "테스터", role: "member" });
  if (u.pathname === "/api/v1/status" && m === "GET") return json(200, { engine_online: true, queue_count: 0, running_count: 1, gpu_name: "RTX TEST" });
  if (u.pathname === "/api/v1/settings" && m === "GET") return json(200, { defaults: { cot: "full", semantic_max_tokens: 9000, format: "flac" }, presets: [{ id: "balanced", name: "권장 품질", recommended: true, summary: "BF16 · 32단계 · FLAC", settings: { ode_steps: 32, quantization: "none" } }], fields: [{ key: "ode_steps", type: "number", min: 4, max: 128, integer: true }, { key: "caption", type: "text", max_length: 4000 }], models: { model: ["m-a-p/YuE2-3B"] }, capabilities: { exact_duration: false, sample_rate: 48000 }, limits: { max_active_jobs_per_user: 8 } });
  return json(404, { detail: "unhandled " + m + " " + u.pathname });
}
`;

function fixture({ check = "() => null", final = "completed" } = {}) {
  return SERVER.replace("CHECK", check).replace("__FINAL__", JSON.stringify(final));
}

function run(args, fixtureSrc, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aicowork-yue-test-"));
  const fixturePath = join(dir, "fixture.mjs");
  writeFileSync(fixturePath, fixtureSrc);
  const res = spawnSync(process.execPath, [dispatcher, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      YUE_API_KEY: KEY,
      AICOWORK_YUE_TEST_FIXTURE: fixturePath,
      AICOWORK_YUE_CONFIG_DIR: join(dir, "no-config"),
      ...env
    }
  });
  return { ...res, dir };
}

const FAST = ["--poll-ms", "10"];

// ---- compose ------------------------------------------------------------------------

test("compose: vocal happy path — body shaped, Idempotency-Key + UA, poll, audio + sibling score saved, PLAN line", () => {
  const check = `(b) => b.title !== "오늘의 노래" ? "title " + b.title : b.preset !== "balanced" ? "preset" : b.settings.caption !== "Warm acoustic folk pop." ? "caption" : b.settings.lyrics !== "[verse]\\n창가에\\n[chorus]\\n천천히" ? "lyrics " + JSON.stringify(b.settings.lyrics) : b.settings.cot !== "full" ? "cot" : b.settings.seed !== "831001" || b.settings.randomize_seed !== false ? "seed" : b.settings.semantic_max_tokens !== 4500 ? "tokens " + b.settings.semantic_max_tokens : "instrumental_lora" in b.settings ? "lora leaked" : null`;
  const r = run(["compose", "Warm acoustic folk pop.", "--lyrics", "[verse]\n창가에\n[chorus]\n천천히", "--title", "오늘의 노래", "--preset", "balanced", "--cot", "full", "--seed", "831001", "--max-seconds", "180", "--output", "song.flac", ...FAST], fixture({ check }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /JOB: job1 queued "오늘의 노래" \(vocal, cot=full, preset=balanced, cap ≈180s, flac\) Idempotency-Key=[0-9a-f-]{36}/);
  assert.match(r.stderr, /running · 합성 중 · 40%/);
  assert.match(r.stdout, /SAVED: .*song\.flac \(job=job1, 47\.3s of cap ≈180s, flac, seed=831001, cot=full, elapsed=130\.5s\)/);
  assert.match(r.stdout, /SCORE SAVED: .*song\.abc \(job=job1, \d+ chars ABC\)/);
  assert.match(r.stdout, /PLAN: reusable — re-render the same plan with: compose --from-plan job1/);
  assert.equal(readFileSync(join(r.dir, "song.flac"), "utf8"), "fLaC-job1");
  assert.match(readFileSync(join(r.dir, "song.abc"), "utf8"), /^X:1/);
});

test("compose: --no-score skips the sibling .abc; title defaults to output stem; format from extension", () => {
  const check = `(b) => b.title !== "bgm" ? "title " + b.title : b.settings.format !== "mp3" ? "format" : null`;
  const r = run(["compose", "Lo-fi.", "--output", "out/bgm.mp3", "--no-score", ...FAST], fixture({ check }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SAVED: .*bgm\.mp3/);
  assert.doesNotMatch(r.stdout, /SCORE SAVED/);
  assert.ok(!existsSync(join(r.dir, "out", "bgm.abc")));
});

test("compose: --instrumental sends LoRA trio with structure-only lyrics", () => {
  const check = `(b) => b.settings.instrumental_lora !== true ? "lora" : b.settings.cot !== "full" ? "cot" : b.settings.quantization !== "none" ? "quant" : b.settings.lyrics !== "[intro]\\n[verse]\\n[chorus]\\n[outro]" ? "lyrics " + JSON.stringify(b.settings.lyrics) : null`;
  const r = run(["compose", "Instrumental piano and cello, no vocals.", "--instrumental", "--lyrics", "[Intro]\n[Verse]\n[Chorus]\n[Outro]", "--output", "inst.flac", ...FAST], fixture({ check }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /JOB: job1 queued "inst" \(instrumental-lora, cot=full/);
  assert.match(r.stdout, /instrumental-lora, cot=full/);
});

test("compose: --plan-only saves only the score as .abc", () => {
  const check = `(b) => b.settings.stage !== "plan" ? "stage" : "format" in b.settings ? "format leaked" : null`;
  const r = run(["compose", "c", "--plan-only", "--cot", "melody", "--output", "plan.flac", ...FAST], fixture({ check }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /NOTE: saving as \.abc/);
  assert.match(r.stderr, /PLAN ONLY/);
  assert.match(r.stdout, /SCORE SAVED: .*plan\.abc/);
  assert.doesNotMatch(r.stdout, /^SAVED:/m);
  assert.deepEqual(readdirSync(r.dir).filter(f => f.startsWith("plan")), ["plan.abc"]);
});

test("compose: --abc-file + --lyrics-file (BOM) for a cover re-arrangement", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicowork-yue-files-"));
  writeFileSync(join(dir, "score.abc"), "﻿X:1\r\nK:D\r\n");
  writeFileSync(join(dir, "lyrics.txt"), "﻿[verse]\n새 가사\n");
  const check = `(b) => b.settings.abc !== "X:1\\nK:D\\n" ? "abc " + JSON.stringify(b.settings.abc) : b.settings.lyrics !== "[verse]\\n새 가사" ? "lyrics" : b.settings.cot !== "melody" ? "cot" : null`;
  const r = run(["compose", "Jazz-funk, Rhodes piano.", "--abc-file", join(dir, "score.abc"), "--lyrics-file", join(dir, "lyrics.txt"), "--cot", "melody", ...FAST], fixture({ check }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /abc given/);
});

test("compose: --from-plan sends top-level source_plan_id, no preset, only synthesis knobs", () => {
  const id = "b2fce105-98bc-4670-81c6-fe2ca619f042";
  const check = `(b) => b.source_plan_id !== "${id}" ? "plan" : "preset" in b ? "preset leaked" : "caption" in b.settings ? "caption leaked" : b.settings.ode_steps !== 48 ? "steps" : b.title !== "Same plan, new render" ? "title " + b.title : null`;
  const r = run(["compose", "--from-plan", id, "--steps", "48", ...FAST], fixture({ check }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`from-plan ${id}, preset=n/a`));
});

test("compose: token-cap NOTE when the result runs up to the cap", () => {
  // fixture result is 47.3 s; cap 1200 tokens ≈ 48 s → ≥97 %
  const r = run(["compose", "c", "--max-tokens", "1200", ...FAST], fixture());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /NOTE: the piece runs right up to the token cap \(≈48s\)/);
});

test("compose: --no-wait submits only", () => {
  const r = run(["compose", "c", "--no-wait"], fixture({ final: "hang" }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /JOB_ID: job1/);
});

test("compose: local validation exits 4 before HTTP", () => {
  const never = "export async function fixtureFetch() { throw new Error('must not be called'); }";
  assert.equal(run(["compose", "c", "--instrumental", "--lyrics", "[solo]"], never).status, 4);
  assert.equal(run(["compose", "c", "--instrumental", "--cot", "off"], never).status, 4);
  assert.equal(run(["compose", "c", "--plan-only", "--cot", "off"], never).status, 4);
  assert.equal(run(["compose", "c", "--max-tokens", "9001"], never).status, 4);
  assert.equal(run(["compose", "c", "--seed", "18446744073709551615"], never).status, 4);
  assert.equal(run(["compose", "c", "--format", "opus"], never).status, 4);
  assert.equal(run(["compose", "--from-plan", "nope"], never).status, 4);
  const r = run(["compose", "c", "--instrumental", "--lyrics", "[intro 0:00-0:20]\n[verse 0:15-0:40]"], never);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /overlaps/);
});

test("compose: no caption exits 2; no key exits 1; failed exits 7; timeout exits 9; 401 exits 2; 409 exits 3", () => {
  assert.equal(run(["compose"], fixture()).status, 2);
  assert.equal(run(["compose", "c"], fixture(), { YUE_API_KEY: "" }).status, 1);
  const f = run(["compose", "c", ...FAST], fixture({ final: "failed" }));
  assert.equal(f.status, 7);
  assert.match(f.stderr, /JOB FAILED: job1 — CUDA out of memory/);
  assert.match(f.stderr, /--preset memory/);
  const t = run(["compose", "c", "--timeout", "1", ...FAST], fixture({ final: "hang" }));
  assert.equal(t.status, 9);
  assert.match(t.stderr, /TIMEOUT: job job1 is still running \(합성 중, 40%\).*jobs-download job1/);
  const bad = run(["compose", "c", ...FAST], fixture(), { YUE_API_KEY: "yue_wrong" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Key rejected/);
  const a = run(["compose", "c", "--idempotency-key", "k1", "--no-wait"], fixture());
  assert.equal(a.status, 0, a.stderr);
});

// ---- transcribe ------------------------------------------------------------------------------

test("transcribe: raw upload with filename/title/melody_only query, no Idempotency-Key, saves score + source wav", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicowork-yue-src-"));
  const src = join(dir, "src.flac");
  writeFileSync(src, Buffer.alloc(5000, 7));
  const r = run(["transcribe", src, "--title", "커버 악보", "--output", "cover.abc", "--source-wav", "src-norm.wav", ...FAST], fixture());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /JOB: tr1 queued "Cover score · src" \(transcription of src\.flac, melody_only=true\)/);
  assert.match(r.stderr, /TRANSCRIPTION WARNING: tempo estimated at 92 BPM/);
  assert.match(r.stdout, /TRANSCRIBED: job=tr1, source 12\.5s, sheetsage2, melody_only=true/);
  assert.match(r.stdout, /SCORE SAVED: .*cover\.abc \(job=tr1/);
  assert.match(r.stdout, /SOURCE WAV SAVED: .*src-norm\.wav/);
  assert.match(r.stdout, /Next: review the ABC/);
  assert.equal(readFileSync(join(r.dir, "src-norm.wav"), "utf8"), "RIFF-tr1");
});

test("transcribe: --chords sends melody_only=false; unsupported extension / missing file exit 4 / 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicowork-yue-src2-"));
  writeFileSync(join(dir, "a.mp3"), Buffer.alloc(10, 1));
  writeFileSync(join(dir, "a.txt"), "x");
  const r = run(["transcribe", join(dir, "a.mp3"), "--chords", "--no-wait"], fixture());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /melody_only=false/);
  assert.equal(run(["transcribe", join(dir, "a.txt")], fixture()).status, 4);
  assert.equal(run(["transcribe", join(dir, "missing.wav")], fixture()).status, 2);
});

// ---- score tools ----------------------------------------------------------------------------------

test("score-inspect / score-strip / score-compare", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicowork-yue-abc-"));
  const abc = 'X:1\nT:t\nK:D\nV:Vocal\n"D" D2 F2 "A" A2 d2|\n';
  writeFileSync(join(dir, "score.abc"), abc);
  const i = run(["score-inspect", join(dir, "score.abc")], fixture());
  assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /INSPECTION: .*score\.abc/);
  assert.match(i.stdout, /bpm: 92/);
  assert.match(i.stdout, /voices: \[2\]/);
  assert.match(i.stdout, /name="Vocal" notes=4/);

  const s = run(["score-strip", join(dir, "score.abc"), "--keep", "Vocal"], fixture());
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /SCORE SAVED: .*score-melody\.abc \(chords stripped, keep_voice=Vocal/);
  assert.match(s.stdout, /INVARIANTS: keep_voice: "Vocal"; chords_removed: 2/);
  const stripped = readFileSync(join(dir, "score-melody.abc"), "utf8");
  assert.ok(!stripped.includes('"D"'));

  const same = run(["score-compare", join(dir, "score.abc"), join(dir, "score.abc")], fixture());
  assert.match(same.stdout, /MATCH: yes \(voices Vocal, Ins\)/);
  const diff = run(["score-compare", join(dir, "score.abc"), join(dir, "score-melody.abc"), "--voices", "Vocal", "--allow-tempo-change"], fixture());
  assert.match(diff.stdout, /MATCH: NO \(voices Vocal\)/);
  assert.match(diff.stdout, /DIFFERENCES: 1\n  - voice="Vocal" bar=1 kind="pitch"/);
});

// ---- library ---------------------------------------------------------------------------------------

test("jobs-list: kinds, warnings, filters", () => {
  const all = run(["jobs-list"], fixture());
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /JOB: done1  completed .* "오늘의 노래"  song          47\.3s mp3 \+abc plan✓ ⚠ ★  \[api\]/);
  assert.match(all.stdout, /JOB: tr9 .* transcription -/);
  assert.match(all.stdout, /JOB: run1  running/);
  assert.doesNotMatch(run(["jobs-list", "--kind", "transcription"], fixture()).stdout, /done1/);
  assert.doesNotMatch(run(["jobs-list", "--status", "running"], fixture()).stdout, /done1/);
});

test("jobs-get: creation and transcription summaries", () => {
  const g = run(["jobs-get", "done1"], fixture());
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /Job:        done1  "오늘의 노래"  \[creation\]/);
  assert.match(g.stdout, /Warning:    음악 토큰 상한에 도달했습니다\./);
  assert.match(g.stdout, /Length:     47\.3s of cap ≈180s \(4500 tokens\), elapsed 130\.5s/);
  assert.match(g.stdout, /Seed:       831001   cfg=1/);
  assert.match(g.stdout, /Plan reuse: yes — compose --from-plan done1/);
  const t = run(["jobs-get", "tr9"], fixture());
  assert.match(t.stdout, /\[transcription\]/);
  assert.match(t.stdout, /Source:     src\.flac, 12\.5s, melody_only=true/);
  assert.match(t.stdout, /Notes:      tempo estimated at 92 BPM/);
});

test("jobs-download: audio + score for songs; score only for plan jobs; audio only for cot=off", () => {
  const d = run(["jobs-download", "done1", "--output", "late.flac"], fixture());
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stderr, /WARNING: 음악 토큰 상한/);
  assert.match(d.stdout, /SAVED: .*late\.mp3 \(job=done1/);
  assert.match(d.stdout, /SCORE SAVED: .*late\.abc/);
  const p = run(["jobs-download", "plan1", "--output", "p.flac"], fixture());
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /SCORE SAVED: .*p\.abc/);
  assert.doesNotMatch(p.stdout, /^SAVED:/m);
  const o = run(["jobs-download", "off1", "--output", "o.flac"], fixture());
  assert.match(o.stdout, /SAVED: .*o\.flac/);
  assert.doesNotMatch(o.stdout, /SCORE SAVED/);
});

test("jobs-score / jobs-artifact / jobs-bundle / jobs-source-audio / jobs-workflow / edit / cancel / delete", () => {
  const s = run(["jobs-score", "done1"], fixture());
  assert.match(s.stdout, /SCORE SAVED: .*done1\.abc/);
  assert.equal(run(["jobs-score", "off1"], fixture()).status, 3);
  const a = run(["jobs-artifact", "done1", "result.json"], fixture());
  assert.match(a.stdout, /SAVED: .*done1-result\.json \(result\.json/);
  assert.equal(run(["jobs-artifact", "done1", "plan.json"], fixture()).status, 2);
  const b = run(["jobs-bundle", "done1"], fixture());
  assert.match(b.stdout, /SAVED: .*done1-bundle\.zip/);
  const sa = run(["jobs-source-audio", "tr9"], fixture());
  assert.match(sa.stdout, /SOURCE WAV SAVED: .*tr9-source\.wav/);
  const w = run(["jobs-workflow", "done1"], fixture());
  assert.match(w.stdout, /SAVED: .*done1-request\.json \(Studio resubmit request JSON/);
  assert.equal(JSON.parse(readFileSync(join(w.dir, "aicowork-yue", "done1-request.json"), "utf8")).settings.seed, "831001");
  assert.match(run(["jobs-edit", "done1", "--title", "새 제목", "--favorite", "true"], fixture()).stdout, /UPDATED: done1  "새 제목"  ★/);
  assert.match(run(["jobs-cancel", "run1"], fixture()).stdout, /CANCEL: run1 → cancelled/);
  assert.match(run(["jobs-delete", "done1"], fixture()).stdout, /JOB DELETED: done1/);
});

test("status and settings", () => {
  const s = run(["status"], fixture());
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /Key \(masked\):   yue_tes\*+6789/);
  assert.match(s.stdout, /API check:      OK \(key valid\) — tester \(테스터\), member/);
  assert.match(s.stdout, /Engine:         online, queue 0, running 1 \(mine\)/);
  assert.match(s.stdout, /Library:        3 jobs \(2 completed, 1 running, 1 transcription\)/);
  const t = run(["settings"], fixture());
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /semantic_max_tokens\s+9000/);
  assert.match(t.stdout, /balanced\s+권장 품질 \(recommended\) — BF16 · 32단계 · FLAC\n\s+ode_steps=32 quantization="none"/);
  assert.match(t.stdout, /ode_steps\s+4–128 \(int\)/);
  assert.match(t.stdout, /caption\s+≤4000 chars/);
  assert.match(t.stdout, /Capabilities: exact_duration=false sample_rate=48000/);
  assert.match(t.stdout, /Limits:       max_active_jobs_per_user=8/);
});
