# aicowork-yue-in-cc

Claude Code plugin that wraps the **AICowork YuE Studio API** (YuE2-3B + YuE2-Vae, SheetSage2 transcription, at `yue.aicowork.cc`, async `POST /api/v1/jobs`) as slash commands with agent-routed dispatch.

The point of this plugin is not the HTTP call — it's the **judgment layer** in `/aicowork-yue:create`: the agent decides **vocal vs instrumental LoRA**, writes the English **caption**, lays out **section-tagged lyrics** or a **structure-only plan** the LoRA accepts, chooses **cot** (melody+chords / melody / off) and **preset**, sets the **music-token cap** (there is no duration field), fixes **seeds** when comparing, feeds an **ABC score** for covers or re-renders a **saved plan** exactly, and submits with an **Idempotency-Key**. Both the audio and the ABC score are saved.

## Commands

| Command | What it does |
|---|---|
| `/aicowork-yue:create <what music, lyrics or instrumental, rough length, where>` | Text (or ABC / saved plan) → music. Agent picks mode, caption, lyrics/structure, cot, preset, cap, seed; submits, polls, saves audio + `.abc`. |
| `/aicowork-yue:cover <audio file> …` | Upload a recording → SheetSage2 ABC transcription → review/strip → regenerate in a new style with new lyrics. |
| `/aicowork-yue:score [get \| inspect \| strip \| compare]` | ABC score download and CPU tools; hand an edited score back to create. |
| `/aicowork-yue:jobs [list \| get \| download \| bundle \| workflow \| artifact \| source-audio \| rename \| favorite \| cancel \| delete]` | Library management, late downloads, plan-reuse status. |
| `/aicowork-yue:config [<key> \| clear]` | Save / show / clear the personal API key. |
| `/aicowork-yue:status [settings]` | Versions, key state, live key check, engine/queue/GPU, library size; live defaults, presets, ranges, models, limits. |

## Install

```
/plugin marketplace add gmlxo76/aicowork-yue-in-cc
/plugin install aicowork-yue@aicowork-yue-in-cc
```

Then set your key (YuE Studio → API 연동 → 새 API 키; shown once):

```
/aicowork-yue:config yue_...
/aicowork-yue:status
```

## What the dispatcher encodes (API facts)

- Auth `Authorization: Bearer yue_...` only; `User-Agent: YuEStudioClient/1.0`; redirects refused.
- `POST /api/v1/jobs {title?, preset?, source_plan_id?, settings}` + `Idempotency-Key` (same key + same body → same job; different body → 409). Presets `balanced` (BF16, 32 ODE steps, 1024-frame decode, FLAC), `draft` (16 steps), `memory` (AR offload, 512-frame decode); explicit settings override.
- `settings`: `caption` ≤4000 (EN/ZH primary), `lyrics` ≤20000, `abc` ≤50000, `cot full|melody|off`, `stage audio|plan`, `instrumental_lora` (needs `cot=full` + `quantization=none`, lyrics = structure tags only), `seed` digit string ≤2^63-1 + `randomize_seed=false`, `cfg_scale` 0–20, `ode_steps` 4–128, `quantization none|fp8`, `offload_ar`, `vae_core_frames 256|512|1024`, `backend`, `format flac|wav|mp3`, `semantic_max_tokens` 1–9000 (≈25 tokens/s — a cap, not a target), plus semantic/ABC sampling knobs.
- `source_plan_id` (top-level) re-renders a completed creation job's native plan: caption/lyrics/cot/abc/seed/cfg/LoRA fixed, `stage=audio`, randomize off, no preset; only synthesis/sampling knobs change.
- Poll `GET /api/v1/jobs/{id}` ≥3 s apart (`queued → running → completed | failed | cancelled`, `progress`, `stage`, `warning`), then `GET …/audio?index=0&download=true` and `GET …/artifacts/score.abc`. Also `/score` (JSON), `/workflow` (Studio resubmit JSON, not ComfyUI), `/bundle` (native ZIP), `/artifacts/{request,config,result}.json`, `/source-audio` (normalized WAV for transcriptions).
- `POST /api/v1/covers/transcribe?filename=&title=&melody_only=` takes the **raw file bytes** (`application/octet-stream`, ≤90 MiB, 0.1–600 s) and has **no** Idempotency-Key — never auto-retried.
- Score tools `POST /api/v1/score-tools/{inspect,strip-chords,compare}` are CPU-only and understand YuE's limited two-voice (`V:Vocal` / `V:Ins`) ABC dialect.
- Local validation before any HTTP: LoRA trio and structure grammar (tags, all-or-none time ranges, no overlap), `off` cannot take ABC or plan stage, from-plan restrictions, seed/token/step ranges, upload size and type.
- 404 means "not yours or not there"; 429 is the 8-active-jobs-per-account limit shared by Studio and all keys.

## Prompting rules baked into the create skill

1. Mode first: lyrics → vocal song (`cot full`); BGM → instrumental LoRA with structure tags (never real lyrics); existing recording → `cover` (transcribe → strip → `--abc-file --cot melody`); good plan → `--from-plan`; quick test → `--cot off`.
2. Caption: 3–5 concrete English sentences (genre, mood, BPM/key, instruments, vocal language and diction or *"Instrumental, no vocals."*, arc with a complete outro); no durations, no vocal words in instrumental captions.
3. Lyrics: tags one per line, repeat choruses explicitly; LoRA structure: `[instrumental]` alone, section order, or a fully timed guide that steers proportion more than absolute time.
4. Length is a token cap (1500 ≈ 60 s, 4500 ≈ 180 s, 9000 ≈ 360 s); report actual seconds; watch for the cap-hit warning.
5. `balanced` first, `draft` to explore, `memory` on OOM; fix `--seed` to compare; use `--from-plan` to re-synthesize a melody you like.

## Development

```
npm test                 # node --test tests/*.test.mjs (no network — in-memory YuE Studio fixture)
npm run validate:plugin  # claude plugin validate .
```

## License

Apache-2.0
