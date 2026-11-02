import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFlags,
  validateNumber,
  validateSeed,
  validateStructure,
  secondsToTokens,
  maskKey,
  buildCreateRequest,
  resolveFormat,
  summarizeBody,
  ValidationError
} from "../scripts/aicowork-yue.mjs";

// ---- parseFlags / validators ------------------------------------------------

test("parseFlags: positional + valued + boolean flags", () => {
  const { positional, flags } = parseFlags(["Warm", "folk", "--instrumental", "--cot", "full", "--output", "x.flac"]);
  assert.deepEqual(positional, ["Warm", "folk"]);
  assert.equal(flags.instrumental, true);
  assert.equal(flags.cot, "full");
  assert.equal(flags.output, "x.flac");
});

test("validateNumber / validateSeed ranges", () => {
  assert.equal(validateNumber("steps", "128", { min: 4, max: 128, integer: true }), 128);
  assert.throws(() => validateNumber("steps", "3", { min: 4, max: 128, integer: true }), ValidationError);
  assert.equal(validateSeed("seed", "9223372036854775807"), "9223372036854775807");
  assert.throws(() => validateSeed("seed", "9223372036854775808"), ValidationError);
  assert.throws(() => validateSeed("seed", "18446744073709551615"), ValidationError); // 20 digits
  assert.equal(validateSeed("seed", "000831001"), "831001");
});

test("secondsToTokens: ~25 tokens/s, clamped to 1–9000", () => {
  assert.equal(secondsToTokens(60), 1500);
  assert.equal(secondsToTokens(180), 4500);
  assert.equal(secondsToTokens(400), 9000);
  assert.equal(secondsToTokens(0.01), 1);
});

test("maskKey keeps yue_ prefix and 4-char tail", () => {
  const m = maskKey("yue_b-MwXvLDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY0123Tz6Q");
  assert.match(m, /^yue_b-M\*+Tz6Q$/);
  assert.ok(!m.includes("wXvL"));
});

test("summarizeBody: {detail: string}", () => {
  assert.equal(summarizeBody('{"detail":"연주곡 LoRA는 cot=full이 필요합니다."}'), "연주곡 LoRA는 cot=full이 필요합니다.");
});

// ---- validateStructure -----------------------------------------------------------

test("structure: empty → [instrumental]; [instrumental] alone ok; mixed with others rejected", () => {
  assert.equal(validateStructure(""), "[instrumental]");
  assert.equal(validateStructure("  [INSTRUMENTAL]  "), "[instrumental]");
  assert.throws(() => validateStructure("[instrumental]\n[verse]"), /must be the only line/);
});

test("structure: section order normalized to lowercase, one per line", () => {
  assert.equal(validateStructure("[Intro]\r\n[Verse]\n\n[Pre-Chorus]\n[CHORUS]\n[bridge]\n[outro]\n"), "[intro]\n[verse]\n[pre-chorus]\n[chorus]\n[bridge]\n[outro]");
});

test("structure: time guide accepted; mixed / overlapping / reversed rejected; unsupported tags rejected", () => {
  const ok = "[intro 0:00-0:15]\n[verse 0:15-0:45]\n[chorus 0:45-1:10]\n[outro 1:10-1:30]";
  assert.equal(validateStructure(ok), ok);
  assert.throws(() => validateStructure("[intro 0:00-0:15]\n[verse]"), /do not mix/);
  assert.throws(() => validateStructure("[intro 0:00-0:20]\n[verse 0:15-0:45]"), /overlaps/);
  assert.throws(() => validateStructure("[intro 0:20-0:10]"), /later than the start/);
  assert.throws(() => validateStructure("[solo]"), /not a supported tag/);
  assert.throws(() => validateStructure("[guitar solo, distorted]"), /not a supported tag/);
  assert.throws(() => validateStructure("[verse]\n창가에 머문 저녁빛"), /not a supported tag/);
  assert.throws(() => validateStructure("[intro 0:00-0:75]"), /not a supported tag/);
});

// ---- buildCreateRequest: vocal --------------------------------------------------------

test("vocal song: caption + tagged lyrics, cot/preset/seed/cfg/format mapped", () => {
  const r = buildCreateRequest({ caption: "Warm acoustic folk pop, gentle female vocal.", lyrics: "[verse]\n창가에\r\n[chorus]\n천천히", cot: "Full", preset: "balanced", seed: "831001", cfg: 1.0, format: "mp3", title: "오늘의 노래", maxTokens: 4500 });
  assert.equal(r.title, "오늘의 노래");
  assert.equal(r.preset, "balanced");
  assert.equal(r.settings.caption, "Warm acoustic folk pop, gentle female vocal.");
  assert.equal(r.settings.lyrics, "[verse]\n창가에\n[chorus]\n천천히");
  assert.equal(r.settings.cot, "full");
  assert.equal(r.settings.seed, "831001");
  assert.equal(r.settings.randomize_seed, false);
  assert.equal(r.settings.cfg_scale, 1.0);
  assert.equal(r.settings.format, "mp3");
  assert.equal(r.settings.semantic_max_tokens, 4500);
  assert.equal("instrumental_lora" in r.settings, false);
  assert.equal("source_plan_id" in r, false);
});

test("minimal: caption only → caption + empty lyrics, nothing else", () => {
  assert.deepEqual(buildCreateRequest({ caption: "c" }), { settings: { caption: "c", lyrics: "" } });
});

test("--max-seconds converts to tokens; both given → error; min > max → error", () => {
  assert.equal(buildCreateRequest({ caption: "c", maxSeconds: 90 }).settings.semantic_max_tokens, 2250);
  assert.throws(() => buildCreateRequest({ caption: "c", maxSeconds: 90, maxTokens: 100 }), /not both/);
  assert.throws(() => buildCreateRequest({ caption: "c", maxTokens: 100, minTokens: 200 }), /exceeds the max-tokens cap/);
});

test("abc input: sent as settings.abc; rejected with cot off; plan-only rejected with off and with --format", () => {
  const r = buildCreateRequest({ caption: "c", abc: "﻿X:1\r\nT:t\n", cot: "melody" });
  assert.equal(r.settings.abc, "X:1\nT:t\n");
  assert.throws(() => buildCreateRequest({ caption: "c", abc: "X:1", cot: "off" }), /cannot be used with --cot off/);
  assert.throws(() => buildCreateRequest({ caption: "c", planOnly: true, cot: "off" }), /needs --cot full or melody/);
  assert.equal(buildCreateRequest({ caption: "c", planOnly: true }).settings.stage, "plan");
  assert.throws(() => buildCreateRequest({ caption: "c", planOnly: true, format: "wav" }), /drop --format/);
});

test("fp8 / offload / vae / backend / sampling knobs map to API names", () => {
  const r = buildCreateRequest({ caption: "c", fp8: true, offloadAr: true, vaeFrames: 512, backend: "torch-eager", steps: 16, semTemperature: 0.9, semTopP: 0.9, semTopK: 50, semRepPenalty: 1.1, abcTemperature: 0.5, abcTopK: 20, abcMaxTokens: 2048 });
  assert.equal(r.settings.quantization, "fp8");
  assert.equal(r.settings.offload_ar, true);
  assert.equal(r.settings.vae_core_frames, 512);
  assert.equal(r.settings.backend, "torch-eager");
  assert.equal(r.settings.ode_steps, 16);
  assert.equal(r.settings.semantic_temperature, 0.9);
  assert.equal(r.settings.semantic_top_p, 0.9);
  assert.equal(r.settings.semantic_top_k, 50);
  assert.equal(r.settings.semantic_repetition_penalty, 1.1);
  assert.equal(r.settings.abc_temperature, 0.5);
  assert.equal(r.settings.abc_top_k, 20);
  assert.equal(r.settings.abc_max_tokens, 2048);
});

// ---- buildCreateRequest: instrumental LoRA ------------------------------------------------

test("instrumental LoRA: forces cot=full + quantization=none, structure normalized, empty → [instrumental]", () => {
  const r = buildCreateRequest({ caption: "Instrumental piano and cello, no vocals.", instrumental: true });
  assert.equal(r.settings.instrumental_lora, true);
  assert.equal(r.settings.cot, "full");
  assert.equal(r.settings.quantization, "none");
  assert.equal(r.settings.lyrics, "[instrumental]");
  const s = buildCreateRequest({ caption: "c", instrumental: true, lyrics: "[Intro]\n[Verse]\n[Chorus]\n[Outro]" });
  assert.equal(s.settings.lyrics, "[intro]\n[verse]\n[chorus]\n[outro]");
});

test("instrumental LoRA: rejects cot≠full, fp8, real lyrics", () => {
  assert.throws(() => buildCreateRequest({ caption: "c", instrumental: true, cot: "melody" }), /requires --cot full/);
  assert.throws(() => buildCreateRequest({ caption: "c", instrumental: true, fp8: true }), /drop --fp8/);
  assert.throws(() => buildCreateRequest({ caption: "c", instrumental: true, lyrics: "[verse]\nla la la" }), /not a supported tag/);
});

// ---- buildCreateRequest: from-plan -----------------------------------------------------------

test("from-plan: top-level source_plan_id, only synthesis knobs; fixed fields and preset rejected", () => {
  const id = "b2fce105-98bc-4670-81c6-fe2ca619f042";
  const r = buildCreateRequest({ fromPlan: id, steps: 32, format: "wav", maxTokens: 6000, title: "again" });
  assert.equal(r.source_plan_id, id);
  assert.deepEqual(r.settings, { ode_steps: 32, format: "wav", semantic_max_tokens: 6000 });
  assert.equal("preset" in r, false);
  assert.throws(() => buildCreateRequest({ fromPlan: id, preset: "draft" }), /cannot be combined with --preset/);
  assert.throws(() => buildCreateRequest({ fromPlan: id, caption: "new" }), /fixed by the source plan/);
  assert.throws(() => buildCreateRequest({ fromPlan: id, seed: "7" }), /fixed by the source plan/);
  assert.throws(() => buildCreateRequest({ fromPlan: id, instrumental: true }), /fixed by the source plan/);
  assert.throws(() => buildCreateRequest({ fromPlan: id, abcTopK: 10 }), /ABC sampling knobs do not apply/);
  assert.throws(() => buildCreateRequest({ fromPlan: "not-a-uuid" }), /UUID/);
});

// ---- limits / format ------------------------------------------------------------------------------

test("limits: caption 4000, lyrics 20000, abc 50000, title 160, preset/format enums", () => {
  assert.throws(() => buildCreateRequest({ caption: "" }), /caption is empty/);
  assert.throws(() => buildCreateRequest({ caption: "a".repeat(4001) }), /max 4000/);
  assert.throws(() => buildCreateRequest({ caption: "c", lyrics: "a".repeat(20001) }), /max 20000/);
  assert.throws(() => buildCreateRequest({ caption: "c", abc: "a".repeat(50001) }), /max 50000/);
  assert.throws(() => buildCreateRequest({ caption: "c", title: "a".repeat(161) }), /--title/);
  assert.throws(() => buildCreateRequest({ caption: "c", preset: "quality" }), /--preset/);
  assert.throws(() => buildCreateRequest({ caption: "c", format: "opus" }), /--format/);
});

test("resolveFormat: flag wins, else output extension (flac/wav/mp3), else flac", () => {
  assert.equal(resolveFormat("WAV", "x.flac"), "wav");
  assert.equal(resolveFormat(undefined, "song.mp3"), "mp3");
  assert.equal(resolveFormat(undefined, "song.abc"), "flac");
  assert.equal(resolveFormat(undefined, undefined), "flac");
  assert.throws(() => resolveFormat("opus", null), ValidationError);
});
