#!/usr/bin/env node
/*
  aicowork-yue-in-cc dispatcher

  Single entry point wrapping the AICowork YuE Studio API (YuE2-3B + YuE2-Vae,
  SheetSage2 transcription, at https://yue.aicowork.cc). Each handler is
  atomic — build request, submit, poll, download, write file. No intelligence;
  caption / lyrics / structure / cot / preset decisions live in
  skills/create/SKILL.md (read by the Claude Code agent).

  API facts this file encodes (verified against /openapi.json v1.0.0, /api-guide,
  the official yue_client.py and live responses on 2026-09-19):
    - auth:        Authorization: Bearer yue_...   (cookies / URL keys are NOT accepted)
    - UA:          send User-Agent: YuEStudioClient/1.0 (the official client's UA)
    - submit:      POST /api/v1/jobs {title?, preset?, source_plan_id?, settings} → 202 MusicJob
                   header Idempotency-Key ([A-Za-z0-9._:-]{1,128}): same key + same body →
                   same job; different body → 409; new song = new key (UUID)
                   preset balanced | draft | memory; explicit settings override the preset
                   settings (all optional; server default → preset → explicit):
                     caption (≤4000, EN/ZH primary)  lyrics (≤20000)  abc (≤50000)
                     cot full | melody | off (off: no abc, no plan stage)
                     stage audio | plan (plan = score only, no audio)
                     instrumental_lora (bool): requires cot=full + quantization=none;
                       lyrics must then be ONLY structure tags: [instrumental] alone, or
                       [intro]/[verse]/[pre-chorus]/[chorus]/[bridge]/[outro] one per line,
                       optionally ALL with "m:ss-m:ss" ranges (non-overlapping, end > start)
                     seed digit STRING 0–9223372036854775807 + randomize_seed=false to fix
                     cfg_scale 0–20 (1.0; off → 1.01)   ode_steps 4–128 (32; draft 16)
                     quantization none | fp8   offload_ar   vae_core_frames 256|512|1024
                     backend torch | torch-eager   format flac | wav | mp3
                     semantic_max_tokens 1–9000 (~25 tokens per second; NO duration field)
                     semantic_* / abc_* sampling knobs (temperature, top_p, top_k,
                       repetition_penalty, penalty_window, min_tokens, abc_max_tokens)
                   source_plan_id (top-level UUID of my completed creation job with
                     exact_plan_reusable=true): caption/lyrics/cot/abc/seed/cfg/LoRA are
                     fixed, stage=audio, randomize off; cannot be combined with preset
    - poll:        GET /api/v1/jobs/{id} status queued|running|completed|failed|cancelled,
                   progress, stage, warning (token cap reached etc.), kind creation|transcription
    - download:    GET /api/v1/jobs/{id}/audio?index=0&download=true → audio bytes
                   GET /api/v1/jobs/{id}/artifacts/score.abc → ABC text (also request/config/result.json)
                   GET /api/v1/jobs/{id}/score → {"abc": "..."}; /workflow → resubmit JSON;
                   /bundle → ZIP of native files; /source-audio → normalized 48k stereo WAV
    - transcribe:  POST /api/v1/covers/transcribe?filename=&title=&melody_only= with the
                   RAW file bytes (application/octet-stream), ≤90 MiB, 0.1–600 s. No
                   Idempotency-Key support → never auto-retry this POST.
    - score tools: POST /api/v1/score-tools/{inspect|strip-chords|compare} (CPU only)
    - diagnostics: GET /api/v1/me, /api/v1/status, /api/v1/settings (non-billable)
    - errors:      {"detail": "..."}; 404 also means "not yours"; 429 = per-account
                   active-job limit (8) shared by Studio and all keys
*/

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname, basename, extname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const PLUGIN_ID = "aicowork-yue-in-cc";
const KEY_ENV = "YUE_API_KEY"; // same variable the official Python client reads
export const BASE_URL = (process.env.YUE_BASE_URL || process.env.AICOWORK_YUE_BASE_URL || "https://yue.aicowork.cc").replace(/\/+$/, "");
const USER_AGENT = "YuEStudioClient/1.0";

const out = s => process.stdout.write(s + "\n");
const errln = s => process.stderr.write(s + "\n");

// ---- Static API facts ---------------------------------------------------------

export const PRESETS = ["balanced", "draft", "memory"];
export const FORMATS = ["flac", "wav", "mp3"];
export const COT_MODES = ["full", "melody", "off"];
export const STRUCTURE_TAGS = ["intro", "verse", "pre-chorus", "chorus", "bridge", "outro"];
export const TOKENS_PER_SECOND = 25;
export const SEMANTIC_MAX_TOKENS = 9000;
export const SEED_MAX = 9223372036854775807n;
export const CAPTION_MAX = 4000;
export const LYRICS_MAX = 20000;
export const ABC_MAX = 50000;
export const TITLE_MAX = 160;
export const UPLOAD_MAX_BYTES = 94371840; // 90 MiB
export const UPLOAD_EXTS = [".wav", ".flac", ".mp3", ".m4a", ".ogg", ".opus", ".aac"];
const EXT_FOR_FORMAT = { flac: ".flac", wav: ".wav", mp3: ".mp3" };
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---- Errors -------------------------------------------------------------------

export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}
export class ValidationError extends Error {}
export class JobError extends Error {
  constructor(job) {
    super(`job ${job.id} ${job.status}${job.error ? `: ${job.error}` : ""}`);
    this.job = job;
  }
}
export class JobTimeout extends Error {
  constructor(job) {
    super(`job ${job.id} still ${job.status} after timeout`);
    this.job = job;
  }
}

// ---- Config file ----------------------------------------------------------------

function configDir() {
  if (process.env.AICOWORK_YUE_CONFIG_DIR) return process.env.AICOWORK_YUE_CONFIG_DIR;
  if (platform() === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), PLUGIN_ID);
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, PLUGIN_ID);
}

function configFile() { return join(configDir(), "config.json"); }

function readConfigFile() {
  const f = configFile();
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); }
  catch { return null; }
}

function writeConfigFile(obj) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const f = configFile();
  writeFileSync(f, JSON.stringify(obj, null, 2));
  if (platform() !== "win32") {
    try { chmodSync(f, 0o600); } catch { /* best effort */ }
  }
}

export function maskKey(key) {
  if (!key) return "(none)";
  const head = key.startsWith("yue_") ? key.slice(0, 7) : key.slice(0, 3);
  const tail = key.slice(-4);
  const middleLen = Math.max(8, key.length - head.length - tail.length);
  return `${head}${"*".repeat(middleLen)}${tail}`;
}

export function resolveKey() {
  const env = (process.env[KEY_ENV] || "").trim().replace(/^['"]|['"]$/g, "");
  if (env) return { key: env, source: "env" };
  const cfg = readConfigFile();
  if (cfg && cfg.yue_api_key) return { key: String(cfg.yue_api_key).trim(), source: "config-file" };
  return { key: null, source: "none" };
}

async function cmdConfigShow() {
  const { key, source } = resolveKey();
  out(`source: ${source}\nkey: ${maskKey(key)}`);
  process.exitCode = 0;
}

async function cmdConfigSet(args) {
  const key = (args[0] || "").trim().replace(/^['"]|['"]$/g, "");
  if (!key) {
    errln("Usage: config-set <api-key>");
    process.exitCode = 2;
    return;
  }
  if (!key.startsWith("yue_")) {
    errln("note: YuE Studio API keys start with 'yue_' — saving anyway. Your Studio login password is NOT an API key.");
  }
  writeConfigFile({ yue_api_key: key, saved_at: new Date().toISOString() });
  out(`saved\nkey: ${maskKey(key)}\nfile: ${configFile()}`);
  process.exitCode = 0;
}

async function cmdConfigClear() {
  const f = configFile();
  if (existsSync(f)) rmSync(f);
  out(`cleared\nfile: ${f}`);
  process.exitCode = 0;
}

function noKey() {
  errln(`no API key. Run config-set <key> or set ${KEY_ENV}.`);
  process.exitCode = 1;
}

// ---- Fetch loader (test fixture support via env var) ----------------------------

async function getFetch() {
  if (process.env.AICOWORK_YUE_TEST_FIXTURE) {
    const url = pathToFileURL(process.env.AICOWORK_YUE_TEST_FIXTURE).href;
    const mod = await import(url);
    return mod.fixtureFetch;
  }
  return globalThis.fetch;
}

// ---- HTTP -----------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

export function summarizeBody(body) {
  try {
    const j = JSON.parse(body);
    if (typeof j.detail === "string") return j.detail;
    if (Array.isArray(j.detail)) {
      return j.detail.map(d => `${(d.loc || []).slice(1).join(".") || "body"}: ${d.msg}`).join("; ");
    }
  } catch { /* not JSON */ }
  return String(body || "").slice(0, 300);
}

/**
 * One authenticated call. Retries once on 429 / 5xx / network unless
 * retry=false. POST /jobs is safe to retry only because every submit carries
 * an Idempotency-Key; the transcription upload has none and is never retried.
 * Redirects are refused so the Bearer key never leaves the origin.
 */
async function apiFetch(path, init, key, doFetch, { retry = true, retryDelayMs = 3000 } = {}) {
  const url = `${BASE_URL}${path}`;
  const attempts = retry ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await doFetch(url, {
        ...init,
        redirect: "manual",
        headers: { "Authorization": `Bearer ${key}`, "User-Agent": USER_AGENT, "Accept": init.accept || "application/json", ...(init.headers || {}) }
      });
    } catch (e) {
      if (attempt === attempts) throw new HttpError(0, `network: ${e.message}`);
      await sleep(retryDelayMs);
      continue;
    }
    if (res.status >= 300 && res.status < 400) throw new HttpError(res.status, "server redirected — not followed to protect the API key");
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      await sleep(retryDelayMs);
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, await safeText(res));
    return res;
  }
}

async function apiJson(path, init, key, doFetch, opts) {
  const res = await apiFetch(path, init, key, doFetch, opts);
  return res.json();
}

async function apiText(path, key, doFetch) {
  const res = await apiFetch(path, { method: "GET", accept: "*/*" }, key, doFetch);
  return res.text();
}

async function apiBytes(path, key, doFetch) {
  const res = await apiFetch(path, { method: "GET", accept: "*/*" }, key, doFetch);
  return Buffer.from(await res.arrayBuffer());
}

function postJson(path, body, key, doFetch, extraHeaders = {}, opts) {
  return apiJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
    body: JSON.stringify(body)
  }, key, doFetch, opts);
}

// Sets process.exitCode instead of calling process.exit() — exiting while
// undici keep-alive sockets are still closing crashes Node on Windows.
function exitForError(e) {
  if (e instanceof ValidationError) {
    errln(e.message);
    process.exitCode = 4;
    return;
  }
  if (e instanceof JobError) {
    const j = e.job;
    errln(`JOB ${String(j.status).toUpperCase()}: ${j.id}${j.error ? ` — ${j.error}` : ""}`);
    if (j.status === "failed") {
      errln("Hint: memory failures → --preset memory (AR offload, 512-frame decoding) or lower --max-tokens; otherwise simplify caption/lyrics/ABC. Check jobs-list before resubmitting — do not queue duplicates.");
    }
    process.exitCode = 7;
    return;
  }
  if (e instanceof JobTimeout) {
    const j = e.job;
    errln(`TIMEOUT: job ${j.id} is still ${j.status}${j.stage ? ` (${j.stage}, ${pct(j.progress)})` : ""}. It keeps running server-side — fetch later with: jobs-download ${j.id}`);
    process.exitCode = 9;
    return;
  }
  if (!(e instanceof HttpError)) {
    errln(e.stack || e.message);
    process.exitCode = 99;
    return;
  }
  const map = { 401: 2, 403: 2, 400: 3, 404: 3, 408: 6, 409: 3, 410: 3, 413: 4, 422: 4, 429: 5, 500: 5, 502: 5, 503: 5, 504: 5, 0: 6 };
  errln(`HTTP ${e.status}: ${summarizeBody(e.body)}`);
  if (e.status === 401) {
    errln("Key rejected. YuE keys start with 'yue_' and are shown ONCE at creation (Studio → API 연동 → 새 API 키). Keys expire (30 d / 90 d / 1 y / never), can be revoked, and die with a deactivated account. Issue a new key and run config-set.");
  } else if (e.status === 404) {
    errln("Not found for THIS account — wrong job id, or the job/file belongs to another member (also a 404). Plan-only and transcription jobs have no audio.");
  } else if (e.status === 408) {
    errln("Upload timed out — check jobs-list before re-uploading (the transcription path has no Idempotency-Key, so a retry may create a second job).");
  } else if (e.status === 409) {
    errln("Conflict: Idempotency-Key reused with different content, or the source plan / bundle files failed verification. Use a fresh key for a new song; check exact_plan_reusable on the source job.");
  } else if (e.status === 413) {
    errln("Upload too large — the original file must be ≤ 90 MiB (and ≤ 10 minutes). Trim or re-encode first.");
  } else if (e.status === 422) {
    errln("Validation error — check the detail above: LoRA needs cot=full + quantization=none and structure-only lyrics; off cannot take ABC or plan stage; source_plan_id fixes caption/lyrics/cot/abc/seed/cfg/LoRA; ranges per `settings`.");
  } else if (e.status === 429) {
    errln("Per-account active-job limit (8) or upload-check limit reached — Studio and all keys share it. jobs-list --status running / queued, wait or cancel, then retry.");
  } else if (e.status === 503) {
    errln("Engine (or the transcription engine) not ready — run `status`, wait for engine_online: true; ask the admin if it persists.");
  }
  process.exitCode = map[e.status] ?? (e.status >= 500 ? 5 : 99);
}

// ---- status / settings --------------------------------------------------------------

function pluginVersion() {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

function describeFailure(e) {
  if (e instanceof HttpError) {
    if (e.status === 0) return `skipped (${e.body})`;
    return `FAILED (HTTP ${e.status}) — ${e.status === 401 ? "key invalid, expired or revoked" : summarizeBody(e.body)}`;
  }
  return `skipped (${e.message})`;
}

async function cmdStatus() {
  const { key, source } = resolveKey();
  const lines = [
    `Node:           ${process.version} / ${process.platform} ${process.arch}`,
    `Plugin:         ${PLUGIN_ID}@${pluginVersion()}`,
    `Server:         ${BASE_URL}`,
    `API key source: ${source}`,
    `Key (masked):   ${maskKey(key)}`,
    `Ready:          ${key ? "yes" : "no"}`
  ];
  if (key) {
    const doFetch = await getFetch();
    let ok = false;
    try {
      const me = await apiJson("/api/v1/me", { method: "GET" }, key, doFetch, { retry: false });
      lines.push(`API check:      OK (key valid) — ${me.username || "?"}${me.display_name ? ` (${me.display_name})` : ""}${me.role ? `, ${me.role}` : ""}`);
      ok = true;
    } catch (e) {
      lines.push(`API check:      ${describeFailure(e)}`);
    }
    if (ok) {
      try {
        const st = await apiJson("/api/v1/status", { method: "GET" }, key, doFetch, { retry: false });
        lines.push(`Engine:         ${st.engine_online ? "online" : "OFFLINE"}, queue ${st.queue_count ?? "?"}, running ${st.running_count ?? "?"} (mine)`);
        if (st.gpu_name) lines.push(`GPU:            ${st.gpu_name}`);
      } catch (e) {
        lines.push(`Engine:         ${describeFailure(e)}`);
      }
      try {
        const list = await apiJson("/api/v1/jobs", { method: "GET" }, key, doFetch, { retry: false });
        const items = Array.isArray(list.items) ? list.items : [];
        const by = {};
        for (const j of items) by[j.status] = (by[j.status] || 0) + 1;
        const kinds = items.filter(j => j.kind === "transcription").length;
        const summary = Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ");
        lines.push(`Library:        ${items.length} job${items.length === 1 ? "" : "s"}${summary ? ` (${summary}${kinds ? `, ${kinds} transcription` : ""})` : ""}`);
      } catch { /* optional */ }
    }
  }
  out(lines.join("\n"));
  process.exitCode = 0;
}

async function cmdSettings(argv) {
  const { flags } = parseFlags(argv);
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  let s;
  try {
    s = await apiJson("/api/v1/settings", { method: "GET" }, key, doFetch);
  } catch (e) { exitForError(e); return; }
  if (flags.json) { out(JSON.stringify(s, null, 2)); process.exitCode = 0; return; }
  const d = s.defaults || {};
  const lines = ["Defaults:"];
  const show = ["cot", "stage", "instrumental_lora", "seed", "randomize_seed", "cfg_scale", "ode_steps", "quantization", "offload_ar", "vae_core_frames", "backend", "format", "semantic_max_tokens", "semantic_min_tokens", "semantic_temperature", "semantic_top_p", "semantic_top_k", "semantic_repetition_penalty", "abc_temperature", "abc_top_p", "abc_top_k", "abc_repetition_penalty", "abc_max_tokens"];
  for (const k of show) if (k in d) lines.push(`  ${k.padEnd(30)} ${JSON.stringify(d[k])}`);
  if (s.presets) {
    lines.push("Presets:");
    const entries = Array.isArray(s.presets) ? s.presets.map(p => [p.id || p.key || p.name, p]) : Object.entries(s.presets);
    const keyKnobs = ["ode_steps", "quantization", "offload_ar", "vae_core_frames", "backend", "format"];
    for (const [name, p] of entries) {
      const label = p && (p.label || p.name);
      const desc = p && (p.summary || p.description);
      const settings = p && typeof p.settings === "object" ? p.settings : null;
      const compact = settings ? keyKnobs.filter(k => k in settings).map(k => `${k}=${JSON.stringify(settings[k])}`).join(" ") : "";
      lines.push(`  ${String(name).padEnd(10)}${label && label !== name ? ` ${label}` : ""}${p && p.recommended ? " (recommended)" : ""}${desc ? ` — ${desc}` : ""}${compact ? `\n             ${compact}` : ""}`);
    }
  }
  if (Array.isArray(s.fields)) {
    lines.push("Ranges:");
    for (const f of s.fields) {
      if (f.type === "number") lines.push(`  ${f.key.padEnd(30)} ${f.min}–${f.max}${f.integer ? " (int)" : ""}`);
      else if (f.type === "select" && f.options) lines.push(`  ${f.key.padEnd(30)} ${f.options.join(" | ")}`);
      else if (f.type === "text" && f.max_length) lines.push(`  ${f.key.padEnd(30)} ≤${f.max_length} chars`);
    }
  }
  if (s.models && typeof s.models === "object") {
    lines.push("Models:");
    for (const [k, v] of Object.entries(s.models)) lines.push(`  ${k.padEnd(18)} ${Array.isArray(v) ? v.join(", ") : JSON.stringify(v)}`);
  }
  if (s.capabilities) lines.push(`Capabilities: ${Object.entries(s.capabilities).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`);
  if (s.limits) lines.push(`Limits:       ${Object.entries(s.limits).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`);
  for (const k of Object.keys(s)) {
    if (["defaults", "fields", "presets", "models", "capabilities", "limits", "samplers", "schedulers"].includes(k)) continue;
    lines.push(`${k}: ${JSON.stringify(s[k]).slice(0, 400)}`);
  }
  out(lines.join("\n"));
  process.exitCode = 0;
}

// ---- Output filename resolution --------------------------------------------------------

function defaultOutputPath(index = 0, ext = ".flac") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(".", "aicowork-yue", `${ts}-${index + 1}${ext}`);
}

export function resolveOutputPath(p, ctx) {
  if (!p) return defaultOutputPath((ctx && ctx.index) || 0, (ctx && ctx.ext) || ".flac");
  if (!existsSync(p)) return p;
  const dir = dirname(p);
  const ext = extname(p);
  const stem = basename(p, ext);
  for (let v = 2; v < 1000; v++) {
    const cand = join(dir, `${stem}-v${v}${ext}`);
    if (!existsSync(cand)) return cand;
  }
  throw new Error("too many filename collisions");
}

function withExt(p, ext) {
  if (extname(p).toLowerCase() === ext) return p;
  const dir = dirname(p);
  const stem = basename(p, extname(p));
  return resolveOutputPath(join(dir, `${stem}${ext}`));
}

function siblingPath(audioPath, ext) {
  const dir = dirname(audioPath);
  const stem = basename(audioPath, extname(audioPath));
  return resolveOutputPath(join(dir, `${stem}${ext}`));
}

/** Explicit --format wins; else infer from the --output extension; else flac. */
export function resolveFormat(flagFormat, outputPath) {
  if (flagFormat && flagFormat !== true) {
    const f = String(flagFormat).toLowerCase();
    if (!FORMATS.includes(f)) throw new ValidationError(`--format ${f} unsupported (${FORMATS.join(" | ")})`);
    return f;
  }
  if (outputPath && outputPath !== true) {
    const e = extname(String(outputPath)).toLowerCase().slice(1);
    if (FORMATS.includes(e)) return e;
  }
  return "flac";
}

// ---- Arg / flag parsing ----------------------------------------------------------------

export function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function validateNumber(name, raw, { min, max, integer = false }) {
  if (raw === undefined || raw === null || raw === true) return null;
  const s = String(raw).trim();
  const n = Number(s);
  if (s === "" || !Number.isFinite(n)) throw new ValidationError(`--${name} "${raw}" is not a number`);
  if (integer && !Number.isInteger(n)) throw new ValidationError(`--${name} ${raw} must be an integer`);
  if (n < min || n > max) throw new ValidationError(`--${name} ${n} out of range (${min}–${max})`);
  return n;
}

/** Seeds travel as digit strings (0–2^63-1) so precision survives JSON. */
export function validateSeed(name, raw) {
  if (raw === undefined || raw === null || raw === true) return null;
  const s = String(raw).trim();
  if (!/^[0-9]{1,19}$/.test(s)) throw new ValidationError(`--${name} "${raw}" must be a non-negative integer (digits only, ≤19 digits)`);
  if (BigInt(s) > SEED_MAX) throw new ValidationError(`--${name} exceeds ${SEED_MAX}`);
  return String(BigInt(s));
}

function validateEnum(name, raw, allowed) {
  if (raw === undefined || raw === null || raw === true) return null;
  const v = String(raw);
  const hit = allowed.find(a => String(a).toLowerCase() === v.toLowerCase());
  if (hit === undefined) throw new ValidationError(`--${name} ${v} unsupported (${allowed.join(" | ")})`);
  return hit;
}

/**
 * Instrumental-LoRA "lyrics" must be structure tags only. Normalizes case and
 * whitespace, enforces the server's rules locally so the agent gets a clear
 * message before any HTTP: [instrumental] alone, or intro/verse/pre-chorus/
 * chorus/bridge/outro one per line, optionally ALL with m:ss-m:ss ranges that
 * do not overlap and end after they start. Empty → [instrumental].
 */
export function validateStructure(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return "[instrumental]";
  if (lines.some(l => /^\[instrumental\]$/i.test(l))) {
    if (lines.length > 1) throw new ValidationError("[instrumental] must be the only line of the structure — drop the other tags or remove [instrumental]");
    return "[instrumental]";
  }
  const re = /^\[(intro|verse|pre-chorus|chorus|bridge|outro)(?:\s+(\d+):([0-5]\d)-(\d+):([0-5]\d))?\]$/i;
  let timed = null;
  let prevEnd = -1;
  const outLines = [];
  for (const l of lines) {
    const m = re.exec(l);
    if (!m) {
      throw new ValidationError(`structure line "${l}" is not a supported tag — the instrumental LoRA takes only [intro] [verse] [pre-chorus] [chorus] [bridge] [outro] (optionally all with m:ss-m:ss) or [instrumental] alone; real lyrics, [solo] and instrument notes belong in the caption`);
    }
    const hasTime = m[2] !== undefined;
    if (timed === null) timed = hasTime;
    else if (timed !== hasTime) throw new ValidationError("either every structure tag has a time range or none does — do not mix");
    if (hasTime) {
      const start = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      const end = parseInt(m[4], 10) * 60 + parseInt(m[5], 10);
      if (end <= start) throw new ValidationError(`"${l}": the end time must be later than the start`);
      if (start < prevEnd) throw new ValidationError(`"${l}": overlaps the previous section`);
      prevEnd = end;
    }
    outLines.push(`[${m[1].toLowerCase()}${hasTime ? ` ${m[2]}:${m[3]}-${m[4]}:${m[5]}` : ""}]`);
  }
  return outLines.join("\n");
}

/** ~25 music tokens per second; the cap is an upper bound, never a target. */
export function secondsToTokens(sec) {
  return Math.max(1, Math.min(SEMANTIC_MAX_TOKENS, Math.round(sec * TOKENS_PER_SECOND)));
}

/**
 * Turn resolved options into a CreateMusic body {title?, preset?, source_plan_id?, settings}.
 * Only explicitly requested settings are sent so server defaults / preset keep
 * applying. Enforces the per-mode rules the server reports only as 422s.
 */
export function buildCreateRequest(o) {
  const req = {};
  const settings = {};

  if (o.title && o.title !== true) {
    const t = String(o.title).trim();
    if (!t || t.length > TITLE_MAX) throw new ValidationError(`--title must be 1–${TITLE_MAX} chars`);
    req.title = t;
  }
  const preset = validateEnum("preset", o.preset, PRESETS);
  const format = o.format ? validateEnum("format", o.format, FORMATS) : null;

  if (o.fromPlan) {
    const id = String(o.fromPlan).trim();
    if (!UUID_RE.test(id)) throw new ValidationError("--from-plan needs the UUID of one of your completed jobs (exact_plan_reusable=true)");
    if (preset) throw new ValidationError("--from-plan cannot be combined with --preset — pass only the synthesis settings you want to change");
    const fixed = [["caption", "a caption"], ["lyrics", "--lyrics"], ["cot", "--cot"], ["abc", "--abc-file"], ["seed", "--seed"], ["cfg", "--cfg"], ["instrumental", "--instrumental"], ["planOnly", "--plan-only"]];
    for (const [k, label] of fixed) {
      if (o[k] !== undefined && o[k] !== null && o[k] !== false && o[k] !== "") throw new ValidationError(`${label} is fixed by the source plan — drop it, or start a NEW request with the score via --abc-file to change it`);
    }
    for (const k of ["abcTemperature", "abcTopP", "abcTopK", "abcRepPenalty", "abcMinTokens", "abcMaxTokens"]) {
      if (o[k] !== undefined && o[k] !== null) throw new ValidationError("ABC sampling knobs do not apply when reusing a saved plan");
    }
    req.source_plan_id = id;
  } else {
    const caption = String(o.caption || "").replace(/\r\n/g, "\n").trim();
    if (!caption) throw new ValidationError("caption is empty — describe genre, mood, instruments, vocals, tempo and arc");
    if (caption.length > CAPTION_MAX) throw new ValidationError(`caption is ${caption.length} chars (max ${CAPTION_MAX})`);
    settings.caption = caption;

    const cot = validateEnum("cot", o.cot, COT_MODES);
    if (o.instrumental) {
      if (cot && cot !== "full") throw new ValidationError("--instrumental (LoRA) requires --cot full (melody + chords)");
      if (o.fp8) throw new ValidationError("--instrumental (LoRA) requires the original BF16 model — drop --fp8");
      settings.instrumental_lora = true;
      settings.cot = "full";
      settings.quantization = "none";
      settings.lyrics = validateStructure(o.lyrics || "");
    } else {
      const lyrics = String(o.lyrics || "").replace(/\r\n/g, "\n").trim();
      if (lyrics.length > LYRICS_MAX) throw new ValidationError(`lyrics are ${lyrics.length} chars (max ${LYRICS_MAX})`);
      settings.lyrics = lyrics;
      if (cot) settings.cot = cot;
      if (o.fp8) settings.quantization = "fp8";
    }
    if (o.abc) {
      const abc = String(o.abc).replace(/\r\n/g, "\n").replace(/^﻿/, "");
      if (!abc.trim()) throw new ValidationError("--abc-file is empty");
      if (abc.length > ABC_MAX) throw new ValidationError(`ABC is ${abc.length} chars (max ${ABC_MAX})`);
      if (cot === "off") throw new ValidationError("--abc-file cannot be used with --cot off (off generates without a score)");
      settings.abc = abc;
    }
    if (o.planOnly) {
      if (cot === "off") throw new ValidationError("--plan-only (score only) needs --cot full or melody");
      settings.stage = "plan";
    }
    if (o.seed !== undefined && o.seed !== null) {
      settings.seed = o.seed;
      settings.randomize_seed = false;
    }
    if (o.cfg !== undefined && o.cfg !== null) settings.cfg_scale = o.cfg;
    if (preset) req.preset = preset;
    if (o.abcTemperature != null) settings.abc_temperature = o.abcTemperature;
    if (o.abcTopP != null) settings.abc_top_p = o.abcTopP;
    if (o.abcTopK != null) settings.abc_top_k = o.abcTopK;
    if (o.abcRepPenalty != null) settings.abc_repetition_penalty = o.abcRepPenalty;
    if (o.abcMinTokens != null) settings.abc_min_tokens = o.abcMinTokens;
    if (o.abcMaxTokens != null) settings.abc_max_tokens = o.abcMaxTokens;
  }

  // Synthesis / sampling knobs allowed in both flows
  if (o.steps != null) settings.ode_steps = o.steps;
  if (format) settings.format = format;
  if (o.fromPlan && o.fp8) settings.quantization = "fp8";
  if (o.offloadAr) settings.offload_ar = true;
  if (o.vaeFrames != null) settings.vae_core_frames = o.vaeFrames;
  if (o.backend) settings.backend = validateEnum("backend", o.backend, ["torch", "torch-eager"]);
  if (o.maxTokens != null && o.maxSeconds != null) throw new ValidationError("give either --max-tokens or --max-seconds, not both");
  if (o.maxTokens != null) settings.semantic_max_tokens = o.maxTokens;
  if (o.maxSeconds != null) settings.semantic_max_tokens = secondsToTokens(o.maxSeconds);
  if (o.minTokens != null) settings.semantic_min_tokens = o.minTokens;
  if (o.semTemperature != null) settings.semantic_temperature = o.semTemperature;
  if (o.semTopP != null) settings.semantic_top_p = o.semTopP;
  if (o.semTopK != null) settings.semantic_top_k = o.semTopK;
  if (o.semRepPenalty != null) settings.semantic_repetition_penalty = o.semRepPenalty;
  if (settings.semantic_min_tokens != null && settings.semantic_max_tokens != null && settings.semantic_min_tokens > settings.semantic_max_tokens) {
    throw new ValidationError(`--min-tokens ${settings.semantic_min_tokens} exceeds the max-tokens cap ${settings.semantic_max_tokens}`);
  }
  if (settings.stage === "plan" && format) throw new ValidationError("--plan-only produces a score, not audio — drop --format");

  req.settings = settings;
  return req;
}

function fmtSec(n) {
  if (n === undefined || n === null || !Number.isFinite(Number(n))) return "?";
  return String(Math.round(Number(n) * 10) / 10);
}

function pct(p) {
  if (p === undefined || p === null || !Number.isFinite(Number(p))) return "?%";
  const v = Number(p);
  return `${Math.round(v <= 1 ? v * 100 : v)}%`;
}

function readTextFile(path, what) {
  if (!existsSync(path)) throw new ValidationError(`--${what} not found: ${path}`);
  return readFileSync(path, "utf8").replace(/^﻿/, "");
}

function writeOut(outPath, data) {
  mkdirSync(dirname(pathResolve(outPath)), { recursive: true });
  writeFileSync(outPath, data);
  return pathResolve(outPath);
}

// ---- API operations ------------------------------------------------------------------------

async function getJob(id, key, doFetch) {
  return apiJson(`/api/v1/jobs/${encodeURIComponent(id)}`, { method: "GET" }, key, doFetch);
}

async function pollJob(id, key, doFetch, { pollMs = 3000, timeoutMs = 3600000, onProgress } = {}) {
  const start = Date.now();
  let last = "";
  for (;;) {
    const job = await getJob(id, key, doFetch);
    const sig = `${job.status}|${job.stage}|${pct(job.progress)}`;
    if (sig !== last && onProgress) onProgress(job);
    last = sig;
    if (job.status === "completed") return job;
    if (job.status === "failed" || job.status === "cancelled") throw new JobError(job);
    if (Date.now() - start > timeoutMs) throw new JobTimeout(job);
    await sleep(pollMs);
  }
}

function progressLine(j) {
  return `  ${j.status}${j.stage ? ` · ${j.stage}` : ""}${j.status === "running" ? ` · ${pct(j.progress)}` : ""}`;
}

function jobFormat(job, fallback = "flac") {
  const f = job && job.settings && job.settings.format;
  return FORMATS.includes(f) ? f : fallback;
}

function capSeconds(job) {
  const t = job && job.settings && job.settings.semantic_max_tokens;
  return Number.isFinite(Number(t)) ? Math.round(Number(t) / TOKENS_PER_SECOND) : null;
}

function isPlanOnly(job) {
  return !!(job && job.settings && job.settings.stage === "plan");
}

function hasAudio(job) {
  return !!(job && ((Array.isArray(job.outputs) && job.outputs.length) || job.audio_url));
}

function savedLine(outPath, job) {
  const s = job.settings || {};
  const cap = capSeconds(job);
  return `SAVED: ${pathResolve(outPath)} (job=${job.id}, ${fmtSec(job.duration_seconds)}s${cap !== null ? ` of cap ≈${cap}s` : ""}, ${jobFormat(job)}, seed=${s.seed ?? "?"}${s.instrumental_lora ? ", instrumental-lora" : ""}${s.cot ? `, cot=${s.cot}` : ""}, elapsed=${fmtSec(job.elapsed_seconds)}s)`;
}

async function saveScore(job, outPath, key, doFetch) {
  const abc = await apiText(`/api/v1/jobs/${encodeURIComponent(job.id)}/artifacts/score.abc`, key, doFetch);
  const abs = writeOut(outPath, abc);
  out(`SCORE SAVED: ${abs} (job=${job.id}, ${abc.length} chars ABC)`);
  return abs;
}

async function saveAudio(job, outPath, key, doFetch) {
  const bytes = await apiBytes(`/api/v1/jobs/${encodeURIComponent(job.id)}/audio?index=0&download=true`, key, doFetch);
  writeOut(outPath, bytes);
  out(savedLine(outPath, job));
  return outPath;
}

function reportJobExtras(job) {
  if (job.warning) errln(`WARNING: ${job.warning}`);
  if (job.exact_plan_reusable) out(`PLAN: reusable — re-render the same plan with: compose --from-plan ${job.id}`);
  if (job.transcription && Array.isArray(job.transcription.warnings) && job.transcription.warnings.length) {
    for (const w of job.transcription.warnings) errln(`TRANSCRIPTION WARNING: ${typeof w === "string" ? w : JSON.stringify(w)}`);
  }
}

/** Save what a completed job has: audio (+ sibling .abc) or score only. */
async function saveJobResults(job, { audioPath, scorePath, wantScore = true }, key, doFetch) {
  const saved = [];
  if (hasAudio(job)) {
    await saveAudio(job, audioPath, key, doFetch);
    saved.push(audioPath);
    if (wantScore && job.score_url) {
      saved.push(await saveScore(job, scorePath || siblingPath(audioPath, ".abc"), key, doFetch));
    }
  } else if (job.score_url) {
    saved.push(await saveScore(job, scorePath || withExt(audioPath, ".abc"), key, doFetch));
  } else {
    errln(`NOTE: job ${job.id} (${job.kind || "creation"}) has neither audio nor a score to download`);
  }
  return saved;
}

// ---- compose (the generation subcommand) -----------------------------------------------------

async function cmdCompose(argv) {
  const { positional, flags } = parseFlags(argv);
  let caption = positional.join(" ").trim();
  let lyrics = flags.lyrics && flags.lyrics !== true ? String(flags.lyrics) : "";
  let abc = null;
  try {
    if (flags["caption-file"] && flags["caption-file"] !== true) {
      if (caption) throw new ValidationError("give the caption either inline or via --caption-file, not both");
      caption = readTextFile(String(flags["caption-file"]), "caption-file").trim();
    }
    if (flags["lyrics-file"] && flags["lyrics-file"] !== true) {
      if (lyrics) throw new ValidationError("give lyrics either via --lyrics or --lyrics-file, not both");
      lyrics = readTextFile(String(flags["lyrics-file"]), "lyrics-file");
    }
    if (flags["abc-file"] && flags["abc-file"] !== true) abc = readTextFile(String(flags["abc-file"]), "abc-file");
  } catch (e) { exitForError(e); return; }

  const fromPlan = flags["from-plan"] && flags["from-plan"] !== true ? String(flags["from-plan"]) : null;
  if (!caption && !fromPlan) {
    errln("compose: <caption> required (inline or --caption-file PATH) — or --from-plan JOB_ID to re-render a saved plan");
    process.exitCode = 2;
    return;
  }
  const { key } = resolveKey();
  if (!key) return noKey();

  let req, format, pollMs, timeoutMs, idemKey;
  const outputGiven = flags.output && flags.output !== true ? String(flags.output) : null;
  try {
    format = resolveFormat(flags.format, flags["plan-only"] ? null : outputGiven);
    pollMs = validateNumber("poll-ms", flags["poll-ms"], { min: 10, max: 300000, integer: true }) ?? 3000;
    timeoutMs = (validateNumber("timeout", flags.timeout, { min: 1, max: 86400 }) ?? 3600) * 1000;
    idemKey = flags["idempotency-key"] && flags["idempotency-key"] !== true ? String(flags["idempotency-key"]) : randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idemKey)) throw new ValidationError("--idempotency-key must be 1–128 chars of [A-Za-z0-9._:-]");
    const vae = flags["vae-frames"] && flags["vae-frames"] !== true ? Number(validateEnum("vae-frames", flags["vae-frames"], ["256", "512", "1024"])) : null;
    req = buildCreateRequest({
      caption, lyrics, abc,
      fromPlan,
      instrumental: !!flags.instrumental,
      planOnly: !!flags["plan-only"],
      cot: flags.cot,
      title: flags.title && flags.title !== true ? flags.title : (outputGiven ? basename(outputGiven, extname(outputGiven)) : (fromPlan ? "Same plan, new render" : undefined)),
      preset: flags.preset,
      format: flags.format || (outputGiven && !flags["plan-only"] && FORMATS.includes(extname(outputGiven).toLowerCase().slice(1)) ? format : undefined),
      seed: validateSeed("seed", flags.seed),
      cfg: validateNumber("cfg", flags.cfg, { min: 0, max: 20 }),
      steps: validateNumber("steps", flags.steps, { min: 4, max: 128, integer: true }),
      fp8: !!flags.fp8,
      offloadAr: !!flags["offload-ar"],
      vaeFrames: vae,
      backend: flags.backend,
      maxTokens: validateNumber("max-tokens", flags["max-tokens"], { min: 1, max: SEMANTIC_MAX_TOKENS, integer: true }),
      maxSeconds: validateNumber("max-seconds", flags["max-seconds"], { min: 1, max: 360 }),
      minTokens: validateNumber("min-tokens", flags["min-tokens"], { min: 0, max: SEMANTIC_MAX_TOKENS, integer: true }),
      semTemperature: validateNumber("temperature", flags.temperature, { min: 0, max: 5 }),
      semTopP: validateNumber("top-p", flags["top-p"], { min: 0.01, max: 1 }),
      semTopK: validateNumber("top-k", flags["top-k"], { min: 1, max: 1000, integer: true }),
      semRepPenalty: validateNumber("rep-penalty", flags["rep-penalty"], { min: 0.1, max: 5 }),
      abcTemperature: validateNumber("abc-temperature", flags["abc-temperature"], { min: 0, max: 5 }),
      abcTopP: validateNumber("abc-top-p", flags["abc-top-p"], { min: 0.01, max: 1 }),
      abcTopK: validateNumber("abc-top-k", flags["abc-top-k"], { min: 1, max: 1000, integer: true }),
      abcRepPenalty: validateNumber("abc-rep-penalty", flags["abc-rep-penalty"], { min: 0.1, max: 5 }),
      abcMinTokens: validateNumber("abc-min-tokens", flags["abc-min-tokens"], { min: 0, max: 4096, integer: true }),
      abcMaxTokens: validateNumber("abc-max-tokens", flags["abc-max-tokens"], { min: 1, max: 4096, integer: true })
    });
  } catch (e) { exitForError(e); return; }

  const planOnly = req.settings.stage === "plan";
  const ext = planOnly ? ".abc" : EXT_FOR_FORMAT[format];
  let outPath = resolveOutputPath(outputGiven, { ext });
  if (extname(outPath).toLowerCase() !== ext) {
    errln(`NOTE: saving as ${ext} instead of ${extname(outPath) || "(no ext)"}${planOnly ? " — plan-only jobs produce a score" : ` (--format ${format})`}`);
    outPath = withExt(outPath, ext);
  }

  const doFetch = await getFetch();
  try {
    const job = await postJson("/api/v1/jobs", req, key, doFetch, { "Idempotency-Key": idemKey });
    const s = req.settings;
    const mode = fromPlan ? `from-plan ${fromPlan}` : `${s.instrumental_lora ? "instrumental-lora" : "vocal"}, cot=${s.cot || "server-default"}${s.abc ? ", abc given" : ""}${planOnly ? ", PLAN ONLY" : ""}`;
    const cap = s.semantic_max_tokens != null ? `, cap ≈${Math.round(s.semantic_max_tokens / TOKENS_PER_SECOND)}s` : "";
    errln(`JOB: ${job.id} ${job.status} "${job.title || req.title || ""}" (${mode}, preset=${req.preset || (fromPlan ? "n/a" : "server-default")}${cap}${planOnly ? "" : `, ${format}`}) Idempotency-Key=${idemKey}`);
    if (flags["no-wait"]) {
      out(`JOB_ID: ${job.id}`);
      out(`Fetch later with: jobs-download ${job.id}${outputGiven ? ` --output ${outputGiven}` : ""}`);
      process.exitCode = 0;
      return;
    }
    const done = await pollJob(job.id, key, doFetch, { pollMs, timeoutMs, onProgress: j => errln(progressLine(j)) });
    reportJobExtras(done);
    await saveJobResults(done, { audioPath: outPath, wantScore: !flags["no-score"] }, key, doFetch);
    const cap2 = capSeconds(done);
    if (!planOnly && done.duration_seconds != null && cap2 && done.duration_seconds >= cap2 * 0.97) {
      errln(`NOTE: the piece runs right up to the token cap (≈${cap2}s) — it was probably truncated. Raise --max-tokens (up to 9000 ≈ 360 s) or shorten the structure.`);
    }
  } catch (e) {
    exitForError(e);
    return;
  }
  process.exitCode = 0;
}

// ---- transcribe (cover: audio → ABC score) -------------------------------------------------------

async function cmdTranscribe(argv) {
  const { positional, flags } = parseFlags(argv);
  const file = positional[0];
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    errln(`transcribe: <audio file> required (${UPLOAD_EXTS.join("/")}, ≤90 MiB, 0.1–600 s)`);
    process.exitCode = 2;
    return;
  }
  const { key } = resolveKey();
  if (!key) return noKey();
  let pollMs, timeoutMs, title;
  try {
    const ext = extname(file).toLowerCase();
    if (!UPLOAD_EXTS.includes(ext)) throw new ValidationError(`${ext || "(no extension)"} is not a supported upload type (${UPLOAD_EXTS.join(" ")})`);
    const size = statSync(file).size;
    if (size > UPLOAD_MAX_BYTES) throw new ValidationError(`${basename(file)} is ${(size / 1048576).toFixed(1)} MiB (upload limit 90 MiB) — trim or re-encode first`);
    if (size === 0) throw new ValidationError(`${basename(file)} is empty`);
    pollMs = validateNumber("poll-ms", flags["poll-ms"], { min: 10, max: 300000, integer: true }) ?? 3000;
    timeoutMs = (validateNumber("timeout", flags.timeout, { min: 1, max: 86400 }) ?? 1800) * 1000;
    title = flags.title && flags.title !== true ? String(flags.title).trim().slice(0, TITLE_MAX) : `Cover score · ${basename(file, ext)}`.slice(0, TITLE_MAX);
  } catch (e) { exitForError(e); return; }

  const melodyOnly = !flags.chords;
  const qs = new URLSearchParams({ filename: basename(file), title, melody_only: String(melodyOnly) });
  const doFetch = await getFetch();
  try {
    // Raw bytes, no Idempotency-Key support → never retried.
    const job = await apiJson(`/api/v1/covers/transcribe?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: readFileSync(file)
    }, key, doFetch, { retry: false });
    errln(`JOB: ${job.id} ${job.status} "${job.title || title}" (transcription of ${basename(file)}, melody_only=${melodyOnly})`);
    if (flags["no-wait"]) {
      out(`JOB_ID: ${job.id}`);
      out(`Fetch later with: jobs-score ${job.id} --output score.abc`);
      process.exitCode = 0;
      return;
    }
    const done = await pollJob(job.id, key, doFetch, { pollMs, timeoutMs, onProgress: j => errln(progressLine(j)) });
    reportJobExtras(done);
    const src = done.source_audio || {};
    const tr = done.transcription || {};
    out(`TRANSCRIBED: job=${done.id}, source ${fmtSec(src.duration_seconds ?? tr.source_duration_seconds)}s${tr.method || tr.mode ? `, ${tr.method || tr.mode}` : ""}${src.melody_only !== undefined ? `, melody_only=${src.melody_only}` : ""}`);
    const scorePath = resolveOutputPath(flags.output && flags.output !== true ? String(flags.output) : join(".", "aicowork-yue", `${basename(file, extname(file))}.abc`));
    await saveScore(done, extname(scorePath).toLowerCase() === ".abc" ? scorePath : withExt(scorePath, ".abc"), key, doFetch);
    if (flags["source-wav"] && flags["source-wav"] !== true) {
      const wav = await apiBytes(`/api/v1/jobs/${encodeURIComponent(done.id)}/source-audio`, key, doFetch);
      out(`SOURCE WAV SAVED: ${writeOut(String(flags["source-wav"]), wav)} (normalized 48 kHz stereo 16-bit — not the original bytes)`);
    }
    out(`Next: review the ABC (jobs-get ${done.id} shows warnings), then: compose "<new style caption>" --abc-file <score.abc> --cot melody --lyrics-file <lyrics.txt>`);
  } catch (e) { exitForError(e); return; }
  process.exitCode = 0;
}

// ---- score tools (CPU, no job) -----------------------------------------------------------------------

function readAbcArg(path, what) {
  if (!path || !existsSync(path)) throw new ValidationError(`${what}: <file.abc> required (file not found)`);
  const abc = readFileSync(path, "utf8").replace(/^﻿/, "");
  if (!abc.trim()) throw new ValidationError(`${path} is empty`);
  if (abc.length > ABC_MAX) throw new ValidationError(`${path} is ${abc.length} chars (max ${ABC_MAX})`);
  return abc;
}

function printInspection(obj, indent = "  ") {
  const lines = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) lines.push(`${indent}${k}: ${JSON.stringify(v)}`);
    else if (Array.isArray(v)) {
      if (v.every(x => x === null || typeof x !== "object")) lines.push(`${indent}${k}: ${JSON.stringify(v).slice(0, 200)}`);
      else {
        lines.push(`${indent}${k}: [${v.length}]`);
        for (const item of v.slice(0, 8)) {
          const scalars = Object.entries(item).filter(([, x]) => x === null || typeof x !== "object").map(([a, b]) => `${a}=${JSON.stringify(b)}`).join(" ");
          lines.push(`${indent}  - ${scalars.slice(0, 220)}`);
        }
      }
    } else if (typeof v === "object") {
      const scalars = Object.entries(v).filter(([, x]) => x === null || typeof x !== "object").map(([a, b]) => `${a}=${JSON.stringify(b)}`).join(" ");
      const nested = Object.entries(v).filter(([, x]) => x && typeof x === "object" && !Array.isArray(x));
      lines.push(`${indent}${k}: ${scalars.slice(0, 220) || (nested.length ? "" : "{…}")}`.trimEnd());
      for (const [sub, obj] of nested.slice(0, 8)) {
        const inner = Object.entries(obj).filter(([, x]) => x === null || typeof x !== "object").map(([a, b]) => `${a}=${JSON.stringify(b)}`).join(" ");
        lines.push(`${indent}  ${sub}: ${inner.slice(0, 220) || "{…}"}`);
      }
    }
  }
  return lines.join("\n");
}

async function cmdScoreInspect(argv) {
  const { positional, flags } = parseFlags(argv);
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const abc = readAbcArg(positional[0], "score-inspect");
    const r = await postJson("/api/v1/score-tools/inspect", { abc }, key, doFetch, {}, { retry: false });
    if (flags.json) out(JSON.stringify(r, null, 2));
    else out(`INSPECTION: ${positional[0]}\n${printInspection(r)}`);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdScoreStrip(argv) {
  const { positional, flags } = parseFlags(argv);
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const abc = readAbcArg(positional[0], "score-strip");
    const keep = validateEnum("keep", flags.keep, ["both", "Vocal", "Ins"]) || "both";
    const r = await postJson("/api/v1/score-tools/strip-chords", { abc, keep_voice: keep }, key, doFetch, {}, { retry: false });
    if (flags.json) { out(JSON.stringify(r, null, 2)); process.exitCode = 0; return; }
    if (typeof r.abc !== "string") throw new Error(`unexpected response: ${JSON.stringify(r).slice(0, 200)}`);
    const src = positional[0];
    const outPath = resolveOutputPath(flags.output && flags.output !== true ? String(flags.output) : join(dirname(src), `${basename(src, extname(src))}-melody.abc`));
    const abs = writeOut(outPath, r.abc);
    out(`SCORE SAVED: ${abs} (chords stripped, keep_voice=${keep}, ${r.abc.length} chars)`);
    if (r.invariants) out(`INVARIANTS: ${printInspection(r.invariants, "").replace(/\n/g, "; ")}`);
    out(`Next: compose "<new style caption>" --abc-file ${outPath} --cot melody --lyrics-file <lyrics.txt>`);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdScoreCompare(argv) {
  const { positional, flags } = parseFlags(argv);
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const before = readAbcArg(positional[0], "score-compare <before.abc>");
    const after = readAbcArg(positional[1], "score-compare <after.abc>");
    const body = { before, after, allow_tempo_change: !!flags["allow-tempo-change"] };
    if (flags.voices && flags.voices !== true) {
      const voices = String(flags.voices).split(",").map(v => v.trim()).filter(Boolean).map(v => validateEnum("voices", v, ["Vocal", "Ins"]));
      if (!voices.length || voices.length > 2) throw new ValidationError("--voices takes Vocal, Ins, or Vocal,Ins");
      body.voices = voices;
    }
    const r = await postJson("/api/v1/score-tools/compare", body, key, doFetch, {}, { retry: false });
    if (flags.json) { out(JSON.stringify(r, null, 2)); process.exitCode = 0; return; }
    out(`MATCH: ${r.match === true ? "yes" : r.match === false ? "NO" : "?"}${Array.isArray(r.compared_voices) ? ` (voices ${r.compared_voices.join(", ")})` : ""}`);
    const diffs = Array.isArray(r.differences) ? r.differences : [];
    if (diffs.length) {
      out(`DIFFERENCES: ${diffs.length}`);
      for (const d of diffs.slice(0, 30)) out(`  - ${typeof d === "string" ? d : Object.entries(d).map(([a, b]) => `${a}=${JSON.stringify(b)}`).join(" ")}`);
      if (diffs.length > 30) out(`  … ${diffs.length - 30} more (use --json)`);
    }
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

// ---- jobs -----------------------------------------------------------------------------------------------

function jobLine(j) {
  const s = j.settings || {};
  const kind = j.kind === "transcription" ? "transcription" : (isPlanOnly(j) ? "plan" : (s.instrumental_lora ? "instrumental" : "song"));
  const len = j.duration_seconds != null ? `${fmtSec(j.duration_seconds)}s` : "-";
  return `JOB: ${j.id}  ${String(j.status).padEnd(9)} ${String(j.created_at || "").slice(0, 19)}  "${j.title || ""}"  ${kind.padEnd(13)} ${len}${hasAudio(j) ? ` ${jobFormat(j)}` : ""}${j.score_url ? " +abc" : ""}${j.exact_plan_reusable ? " plan✓" : ""}${j.warning ? " ⚠" : ""}${j.favorite ? " ★" : ""}${j.source ? `  [${j.source}]` : ""}`;
}

async function cmdJobsList(argv) {
  const { flags } = parseFlags(argv);
  const { key } = resolveKey();
  if (!key) return noKey();
  let limit, status;
  try {
    limit = validateNumber("limit", flags.limit, { min: 1, max: 500, integer: true }) ?? 20;
    status = validateEnum("status", flags.status, ["queued", "running", "completed", "failed", "cancelled"]);
  } catch (e) { exitForError(e); return; }
  const qs = new URLSearchParams();
  if (flags.q && flags.q !== true) qs.set("q", String(flags.q));
  if (status) qs.set("status", status);
  const doFetch = await getFetch();
  try {
    const list = await apiJson(`/api/v1/jobs${qs.toString() ? `?${qs}` : ""}`, { method: "GET" }, key, doFetch);
    let items = Array.isArray(list.items) ? list.items : [];
    if (flags.kind && flags.kind !== true) items = items.filter(j => (j.kind || "creation") === String(flags.kind));
    items = items.slice(0, limit);
    if (flags.json) out(JSON.stringify(items, null, 2));
    else if (!items.length) out("(no jobs match)");
    else for (const j of items) out(jobLine(j));
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

function requireId(argv, name) {
  const { positional, flags } = parseFlags(argv);
  const id = positional[0];
  if (!id) {
    errln(`${name}: <JOB_ID> required`);
    process.exitCode = 2;
    return null;
  }
  return { id, flags, positional };
}

async function cmdJobsGet(argv) {
  const p = requireId(argv, "jobs-get");
  if (!p) return;
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const j = await getJob(p.id, key, doFetch);
    if (p.flags.json) { out(JSON.stringify(j, null, 2)); process.exitCode = 0; return; }
    const s = j.settings || {};
    const cap = capSeconds(j);
    const lines = [
      `Job:        ${j.id}  "${j.title || ""}"  [${j.kind || "creation"}${isPlanOnly(j) ? ", plan-only" : ""}]${j.favorite ? "  ★" : ""}`,
      `Status:     ${j.status}${j.stage ? ` · ${j.stage}` : ""}${j.status === "running" ? ` · ${pct(j.progress)}` : ""}${j.error ? ` — ${j.error}` : ""}`,
      `Created:    ${j.created_at || "-"}   completed ${j.completed_at || "-"}   source ${j.source || "-"}`
    ];
    if (j.warning) lines.push(`Warning:    ${j.warning}`);
    if (j.kind === "transcription") {
      const src = j.source_audio || {};
      const tr = j.transcription || {};
      lines.push(`Source:     ${src.name || "?"}, ${fmtSec(src.duration_seconds ?? tr.source_duration_seconds)}s, melody_only=${src.melody_only ?? "?"}`);
      if (tr.method || tr.mode) lines.push(`Method:     ${tr.method || tr.mode}`);
      if (Array.isArray(tr.warnings) && tr.warnings.length) lines.push(`Notes:      ${tr.warnings.map(w => (typeof w === "string" ? w : JSON.stringify(w))).join(" | ")}`);
    } else {
      lines.push(`Length:     ${j.duration_seconds != null ? fmtSec(j.duration_seconds) + "s" : "-"}${cap ? ` of cap ≈${cap}s (${s.semantic_max_tokens} tokens)` : ""}, elapsed ${fmtSec(j.elapsed_seconds)}s`);
      lines.push(`Plan:       cot=${s.cot ?? "?"} stage=${s.stage ?? "audio"} lora=${s.instrumental_lora ? "instrumental" : "none"} abc_input=${s.abc ? `${String(s.abc).length} chars` : "none"}`);
      lines.push(`Seed:       ${s.seed ?? "?"}${s.randomize_seed ? " (was random)" : ""}   cfg=${s.cfg_scale ?? "?"}`);
      lines.push(`Synthesis:  ode_steps=${s.ode_steps ?? "?"} quant=${s.quantization ?? "?"} offload_ar=${s.offload_ar ?? "?"} vae_frames=${s.vae_core_frames ?? "?"} backend=${s.backend ?? "?"} format=${jobFormat(j)}`);
      lines.push(`Sampling:   semantic T=${s.semantic_temperature ?? "?"} p=${s.semantic_top_p ?? "?"} k=${s.semantic_top_k ?? "?"} rep=${s.semantic_repetition_penalty ?? "?"} | abc T=${s.abc_temperature ?? "?"} p=${s.abc_top_p ?? "?"} k=${s.abc_top_k ?? "?"} rep=${s.abc_repetition_penalty ?? "?"}`);
      lines.push(`Caption:    ${String(s.caption || "").replace(/\s+/g, " ").slice(0, 300)}`);
      lines.push(`Lyrics:     ${s.lyrics ? `${String(s.lyrics).split("\n").filter(Boolean).length} lines — ${String(s.lyrics).replace(/\s+/g, " ").slice(0, 120)}${String(s.lyrics).length > 120 ? "…" : ""}` : "(none)"}`);
    }
    lines.push(`Files:      ${hasAudio(j) ? "audio" : "no audio"}${j.score_url ? ", score.abc" : ""}${j.bundle_url ? ", bundle.zip" : ""}${j.source_audio_url ? ", source-audio.wav" : ""}`);
    lines.push(`Plan reuse: ${j.exact_plan_reusable ? `yes — compose --from-plan ${j.id}` : "no"}${j.source_plan_id ? `   (rendered from plan ${j.source_plan_id})` : ""}${j.settings_reusable === false ? "   (settings not reusable in Studio)" : ""}`);
    out(lines.join("\n"));
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdJobsDownload(argv) {
  const p = requireId(argv, "jobs-download");
  if (!p) return;
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const j = await getJob(p.id, key, doFetch);
    if (j.status === "failed" || j.status === "cancelled") throw new JobError(j);
    if (j.status !== "completed") {
      errln(`PENDING: job ${j.id} is ${j.status}${j.stage ? ` (${j.stage}, ${pct(j.progress)})` : ""} — try again later`);
      process.exitCode = 9;
      return;
    }
    reportJobExtras(j);
    const ext = hasAudio(j) ? EXT_FOR_FORMAT[jobFormat(j)] : ".abc";
    let outPath = resolveOutputPath(p.flags.output && p.flags.output !== true ? String(p.flags.output) : null, { ext });
    if (extname(outPath).toLowerCase() !== ext) outPath = withExt(outPath, ext);
    await saveJobResults(j, { audioPath: outPath, wantScore: !p.flags["no-score"] }, key, doFetch);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdJobsScore(argv) {
  const p = requireId(argv, "jobs-score");
  if (!p) return;
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const j = await getJob(p.id, key, doFetch);
    if (!j.score_url) {
      errln(`job ${j.id} has no score (cot=off, or not completed yet: ${j.status})`);
      process.exitCode = 3;
      return;
    }
    let outPath = resolveOutputPath(p.flags.output && p.flags.output !== true ? String(p.flags.output) : join(".", "aicowork-yue", `${j.id}.abc`));
    if (extname(outPath).toLowerCase() !== ".abc") outPath = withExt(outPath, ".abc");
    await saveScore(j, outPath, key, doFetch);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdJobsCancel(argv) {
  const p = requireId(argv, "jobs-cancel");
  if (!p) return;
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const j = await apiJson(`/api/v1/jobs/${encodeURIComponent(p.id)}/cancel`, { method: "POST" }, key, doFetch, { retry: false });
    out(`CANCEL: ${j.id} → ${j.status}${j.status === "running" ? " (cancel requested; check jobs-get)" : ""}`);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdJobsDelete(argv) {
  const p = requireId(argv, "jobs-delete");
  if (!p) return;
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    await apiFetch(`/api/v1/jobs/${encodeURIComponent(p.id)}`, { method: "DELETE" }, key, doFetch, { retry: false });
    out(`JOB DELETED: ${p.id} (hidden from the library; local files untouched)`);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdJobsEdit(argv) {
  const p = requireId(argv, "jobs-edit");
  if (!p) return;
  const body = {};
  if (p.flags.title && p.flags.title !== true) body.title = String(p.flags.title).trim().slice(0, TITLE_MAX);
  if (p.flags.favorite !== undefined) {
    const v = p.flags.favorite === true ? "true" : String(p.flags.favorite).toLowerCase();
    if (!["true", "false"].includes(v)) {
      errln("jobs-edit: --favorite true|false");
      process.exitCode = 2;
      return;
    }
    body.favorite = v === "true";
  }
  if (!Object.keys(body).length) {
    errln("jobs-edit: give --title T and/or --favorite true|false");
    process.exitCode = 2;
    return;
  }
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const j = await apiJson(`/api/v1/jobs/${encodeURIComponent(p.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body)
    }, key, doFetch, { retry: false });
    out(`UPDATED: ${j.id}  "${j.title}"${j.favorite ? "  ★" : ""}`);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdJobsWorkflow(argv) {
  const p = requireId(argv, "jobs-workflow");
  if (!p) return;
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const wf = await apiJson(`/api/v1/jobs/${encodeURIComponent(p.id)}/workflow`, { method: "GET" }, key, doFetch);
    const outPath = resolveOutputPath(p.flags.output && p.flags.output !== true ? String(p.flags.output) : join(".", "aicowork-yue", `${p.id}-request.json`));
    out(`SAVED: ${writeOut(outPath, JSON.stringify(wf, null, 2))} (Studio resubmit request JSON with the actual seed for job ${p.id} — not a ComfyUI workflow)`);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdJobsBundle(argv) {
  const p = requireId(argv, "jobs-bundle");
  if (!p) return;
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const zip = await apiBytes(`/api/v1/jobs/${encodeURIComponent(p.id)}/bundle`, key, doFetch);
    const outPath = resolveOutputPath(p.flags.output && p.flags.output !== true ? String(p.flags.output) : join(".", "aicowork-yue", `${p.id}-bundle.zip`));
    out(`SAVED: ${writeOut(outPath, zip)} (${(zip.length / 1048576).toFixed(1)} MiB native bundle: plan/tokens/latents/score/config/audio as present)`);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdJobsArtifact(argv) {
  const p = requireId(argv, "jobs-artifact");
  if (!p) return;
  const name = p.positional[1];
  const allowed = ["request.json", "config.json", "result.json", "score.abc"];
  if (!name || !allowed.includes(name)) {
    errln(`jobs-artifact: <JOB_ID> <${allowed.join(" | ")}> required`);
    process.exitCode = 2;
    return;
  }
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const text = await apiText(`/api/v1/jobs/${encodeURIComponent(p.id)}/artifacts/${name}`, key, doFetch);
    const outPath = resolveOutputPath(p.flags.output && p.flags.output !== true ? String(p.flags.output) : join(".", "aicowork-yue", `${p.id}-${name}`));
    out(`SAVED: ${writeOut(outPath, text)} (${name}, ${text.length} chars)`);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

async function cmdJobsSourceAudio(argv) {
  const p = requireId(argv, "jobs-source-audio");
  if (!p) return;
  const { key } = resolveKey();
  if (!key) return noKey();
  const doFetch = await getFetch();
  try {
    const wav = await apiBytes(`/api/v1/jobs/${encodeURIComponent(p.id)}/source-audio`, key, doFetch);
    const outPath = resolveOutputPath(p.flags.output && p.flags.output !== true ? String(p.flags.output) : join(".", "aicowork-yue", `${p.id}-source.wav`));
    out(`SOURCE WAV SAVED: ${writeOut(outPath, wav)} (normalized 48 kHz stereo 16-bit — not the original bytes)`);
    process.exitCode = 0;
  } catch (e) { exitForError(e); }
}

// ---- main -------------------------------------------------------------------------------------------------------

const USAGE = `Usage: aicowork-yue.mjs <subcommand> [args...]

Diagnostic:
  status                          Node/plugin versions, key state, live key check (GET /api/v1/me),
                                  engine online / my queue, library size.
  settings [--json]               Live defaults, presets, ranges, models, capabilities, limits.

Config:
  config-show | config-set <key> | config-clear     (key: yue_..., env ${KEY_ENV})

Generation (POST /api/v1/jobs → poll ≥3 s → audio and/or score.abc):
  compose <caption> | --caption-file PATH | --from-plan JOB_ID
      --lyrics S | --lyrics-file PATH   vocal lyrics with [verse]/[chorus]… tags (one per line)
      --instrumental    instrumental AR LoRA: forces cot=full + BF16; --lyrics must be structure
                        tags only ([instrumental] alone, or intro/verse/pre-chorus/chorus/bridge/outro,
                        optionally all with m:ss-m:ss). Empty → [instrumental].
      --cot M           full (melody+chords, default) | melody | off (no score)
      --abc-file PATH   use this ABC score instead of composing one (not with --cot off)
      --plan-only       stage=plan: compose the score only, save .abc, no audio
      --from-plan ID    source_plan_id: re-render a saved plan (caption/lyrics/cot/abc/seed/cfg/LoRA fixed;
                        no --preset; only synthesis/sampling knobs may change)
      --title T         library title (default: --output file stem)
      --preset P        balanced | draft | memory
      --max-tokens N    semantic_max_tokens 1–9000 (~25/s; 4500 ≈ 180 s). --max-seconds S converts for you.
                        A CAP, not a target — the model may stop early or be cut at the cap.
      --min-tokens N    semantic_min_tokens
      --seed N          fix the seed (digit string ≤ 2^63-1; randomize off)   --cfg F  0–20 (1.0; off → 1.01)
      --steps N         ode_steps 4–128 (32; draft 16)     --format F  flac (default) | wav | mp3
      --fp8 | --offload-ar | --vae-frames 256|512|1024 | --backend torch|torch-eager
      --temperature --top-p --top-k --rep-penalty              music-token sampling
      --abc-temperature --abc-top-p --abc-top-k --abc-rep-penalty --abc-min-tokens --abc-max-tokens
      --output PATH     audio target (score saved next to it as .abc unless --no-score);
                        omit → ./aicowork-yue/<UTC>-1.<ext>. Collisions auto-version -v2.
      --idempotency-key K   reuse only to recover a lost reply (default: new UUID)
      --no-wait         submit only, print JOB_ID       --timeout S  default 3600   --poll-ms N  default 3000

Cover (audio → ABC score, SheetSage2):
  transcribe <audio file> [--title T] [--chords] [--output score.abc] [--source-wav PATH] [--no-wait]
                                  raw upload ≤90 MiB, 0.1–600 s; --chords keeps estimated chord symbols
                                  (default melody_only=true). No Idempotency-Key on this path.

Score tools (CPU, no job):
  score-inspect <file.abc> [--json]
  score-strip <file.abc> [--keep both|Vocal|Ins] [--output PATH]     chords removed for a new arrangement
  score-compare <before.abc> <after.abc> [--voices Vocal,Ins] [--allow-tempo-change] [--json]

Library:
  jobs-list [--q TEXT] [--status S] [--kind creation|transcription] [--limit N] [--json]
  jobs-get <JOB_ID> [--json]        jobs-download <JOB_ID> [--output PATH] [--no-score]
  jobs-score <JOB_ID> [--output PATH]            jobs-artifact <JOB_ID> <request.json|config.json|result.json|score.abc>
  jobs-workflow <JOB_ID>            jobs-bundle <JOB_ID> [--output PATH]      jobs-source-audio <JOB_ID> [--output PATH]
  jobs-edit <JOB_ID> [--title T] [--favorite true|false]     jobs-cancel <JOB_ID>     jobs-delete <JOB_ID>

Exit codes:
  0 success, 1 no key, 2 auth/missing-input, 3 not-found/conflict, 4 validation (incl. 413),
  5 rate-limit/engine, 6 network/timeout, 7 job failed/cancelled, 9 job still running, 99 unknown.
`;

const handlers = {
  "status": cmdStatus,
  "settings": cmdSettings,
  "config-show": cmdConfigShow,
  "config-set": cmdConfigSet,
  "config-clear": cmdConfigClear,
  "compose": cmdCompose,
  "transcribe": cmdTranscribe,
  "score-inspect": cmdScoreInspect,
  "score-strip": cmdScoreStrip,
  "score-compare": cmdScoreCompare,
  "jobs-list": cmdJobsList,
  "jobs-get": cmdJobsGet,
  "jobs-download": cmdJobsDownload,
  "jobs-score": cmdJobsScore,
  "jobs-cancel": cmdJobsCancel,
  "jobs-delete": cmdJobsDelete,
  "jobs-edit": cmdJobsEdit,
  "jobs-workflow": cmdJobsWorkflow,
  "jobs-bundle": cmdJobsBundle,
  "jobs-artifact": cmdJobsArtifact,
  "jobs-source-audio": cmdJobsSourceAudio
};

const isMain = process.argv[1] && pathToFileURL(pathResolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const sub = process.argv[2];
  const handler = handlers[sub];
  if (!handler) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  handler(process.argv.slice(3)).catch(e => {
    process.stderr.write(`${e.stack || e.message}\n`);
    process.exitCode = 99;
  });
}
