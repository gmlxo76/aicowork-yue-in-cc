---
description: Generate music via AICowork YuE Studio (YuE2-3B) — you decide vocal vs instrumental-LoRA, write the English caption and section-tagged lyrics or a structure-only plan, choose cot (melody+chords / melody / off), preset, the music-token cap and seed, optionally feed an ABC score or re-render a saved plan, then submit, wait, and save FLAC/WAV/MP3 plus the ABC score
argument-hint: '<natural language: what kind of music, lyrics or instrumental, rough length, where to save>'
allowed-tools: Bash(node:*), Write
---

# Create (aicowork-yue)

The single user-facing command for YuE generation. The user describes a song in any language, maybe pastes lyrics or an ABC score; **you** (the Claude Code agent) pick vocal vs **instrumental LoRA**, write the English **caption**, lay out **tagged lyrics** or a **structure-only plan**, choose **cot** and **preset**, set the **music-token cap**, fix **seeds** when comparing, and call the dispatcher. YuE plans an ABC score first (unless `cot=off`), then synthesizes 48 kHz stereo audio; both are saved.

## Step 1 — Parse `$ARGUMENTS`

1. If `$ARGUMENTS` begins with `[Image #N]`, strip it and warn: *"aicowork-yue generates audio from text / ABC only."*
2. Extract:
   - **Music direction** — genre, mood, instruments, vocals (gender/language), tempo, arc → §3 caption.
   - **Lyrics** — quoted/indented lines or a `.txt` path → `--lyrics-file`. Used verbatim; you only add section tags.
   - **Instrumental cue** (`연주곡`, `가사 없이`, `BGM`, `no vocals`) → `--instrumental` (LoRA) — see §2 for when to prefer plain mode.
   - **Structure / timing wishes** (`인트로-벌스-코러스-…`, `2분 30초 구성`) → structure tags for the LoRA (§4).
   - **ABC score** (`.abc` path, `이 악보로`, `커버`, output of `/aicowork-yue:cover` or `:score`) → `--abc-file` (+ `--cot melody` for re-arrangements).
   - **Score only** (`악보만`, `멜로디 먼저 보자`) → `--plan-only`.
   - **Re-render** (`같은 계획으로 다시`, `그 곡 다시 합성`) → `--from-plan JOB_ID` (job must show `Plan reuse: yes`).
   - **Length** (`1분`, `3분짜리`) → `--max-seconds` (a **cap**, §5). Default: leave server default (9000 tokens ≈ 6 min cap) for songs; `--max-seconds 90` for BGM/jingles so runaway pieces stop.
   - **Quality intent** — `시안`/`빨리` → `draft`; OOM history / `메모리` → `memory`; else `balanced`.
   - **Reproducibility** (`같은 시드`, `seed …`) → `--seed`.
   - **Format** — `flac` default (master); `wav` when a DAW needs it; `mp3` for sharing.
   - **Title** — user's title, else a short Korean/English title. Always pass `--title` or a meaningful `--output` stem.
   - **Output path** → `--output PATH` (the ABC score is saved next to it as `.abc`).

## Step 2 — Decide the mode

| Request | What you send |
|---|---|
| Song with lyrics | caption + `--lyrics-file` (tagged, §4), `--cot full` (default) |
| Song, no lyrics supplied, singing wanted | write short original lyrics in the user's language, tagged; say you wrote them |
| Instrumental / BGM / jingle | `--instrumental` (LoRA) with structure tags; caption starts with *"Instrumental, no vocals."* |
| Instrumental where the LoRA is unwanted (FP8, `cot melody`, or an existing ABC with chords stripped) | plain mode: empty lyrics, caption says *"instrumental, no vocals"*; no `--instrumental` |
| Cover / new arrangement of an ABC (from `:cover` or `:score`) | `--abc-file score.abc --cot melody` + new-style caption + the user's real lyrics (or empty for instrumental) |
| Score first, audio later | `--plan-only --cot full|melody`; then either `--from-plan` (exact) or `--abc-file` (after editing) |
| Same result again / another synthesis of a good plan | `--from-plan JOB_ID` (+ only `--steps`, `--format`, sampling, memory knobs) |
| Fast experiment without a score | `--cot off` (no ABC input, no plan-only, cfg starts at 1.01) |

Rules:
- **LoRA rules are hard:** `--instrumental` forces `cot=full` and BF16; lyrics must be structure tags only — the dispatcher rejects real lyrics, `[solo]`, instrument notes and `--fp8` locally. Put instrument/solo wishes in the caption.
- **`melody` ≠ instrumental.** It only narrows the plan to melody; vocals still follow the caption/lyrics.
- **`melody` does not strip chords** from an input ABC — run `/aicowork-yue:score strip` first if the user wants a new harmony.
- **Korean lyrics work but English/Chinese are the model's primary languages**; warn once that pronunciation and lyric adherence may vary, and keep lines short.
- Announce your plan in one line before dispatching, e.g. *"연주곡 LoRA, 인트로-벌스-코러스-브리지-코러스-아웃트로 구성, balanced, 상한 약 2분 30초로 생성합니다."*

## Step 3 — Write the caption (English)

Three to five short sentences, concrete nouns:

```
<Genre / style>, <mood>, <tempo BPM>, <key>. <Instruments and their roles>. <Vocal: gender, timbre, language and diction — or "Instrumental, no vocals."> <Arc: intro → verses → chorus → bridge/interlude → ending, "finish with a quiet complete outro">.
```

Examples:
```
Warm acoustic folk pop, gentle female vocals, fingerpicked guitar, soft piano and brushed drums. 88 BPM, D major. Intimate verses, an uplifting chorus and a quiet instrumental outro.
```
```
Instrumental, no vocals. Lyrical solo piano and expressive violin, with warm cello accompaniment. Wistful, elegant and gently flowing. Begin with delicate piano arpeggios, introduce a violin melody, build gradually to an emotional climax, then finish with a quiet piano outro.
```

Rules: English caption; ≤4000 chars; name instruments and the arc; for vocals state language and diction (*"clear Korean diction"*); never write durations or token counts into the caption; for instrumentals the caption must not mention vocals, choir or humming (leftover vocal words are the usual cause of stray voices).

## Step 4 — Lyrics and structure

**Vocal lyrics** (plain mode): tags one per line, lowercase is fine — `[intro]` `[verse]` `[pre-chorus]` `[chorus]` `[bridge]` `[outro]`; lines after a tag belong to it; repeat a chorus by writing it again. Real newlines (write a file, use `--lyrics-file`), never a literal `\n`.

**Instrumental LoRA structure** (goes in the lyrics slot) — pick one form:
- Auto: `[instrumental]` alone (or leave lyrics empty).
- Section order:
  ```
  [intro]
  [verse]
  [chorus]
  [bridge]
  [chorus]
  [outro]
  ```
- Time guide (all sections timed, `m:ss-m:ss`, no overlaps):
  ```
  [intro 0:00-0:15]
  [verse 0:15-0:45]
  [chorus 0:45-1:10]
  [bridge 1:10-1:40]
  [chorus 1:40-2:05]
  [outro 2:05-2:30]
  ```
  Allowed tags: intro, verse, pre-chorus, chorus, bridge, outro. The LoRA author notes time tags steer **order and proportion** more than absolute time, and pieces tend toward 3–5 min regardless — so set `--max-seconds` to stop runaway length. `chorus` in an instrumental means the recurring theme, not vocals.

## Step 5 — Length, preset, seed

- **There is no duration setting.** `semantic_max_tokens` (≈25 tokens/s) is a cap: 1500 ≈ 60 s, 4500 ≈ 180 s, 9000 ≈ 360 s (default). The piece may end early, or be cut at the cap — the dispatcher prints a NOTE when the result runs right up to it; raise the cap or shorten the structure. Report the **actual** length from `SAVED:`.
- Presets (`balanced` 32 steps BF16 default · `draft` 16 steps · `memory` AR-offload + 512-frame decoding). More `--steps` or higher `--cfg` do not reliably improve melody, vocals or lyric adherence.
- `--seed N` fixes the seed (randomize off) — the only way to compare one changed setting. Read actual seeds from `jobs-get`.
- Memory failures (`CUDA out of memory`) → `--preset memory` or a lower cap; never resubmit blindly.

## Step 6 — Build the dispatcher call

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" compose "<caption>" --lyrics-file lyrics.txt --title "<title>" --preset balanced --output song.flac
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" compose "<instrumental caption>" --instrumental --lyrics-file structure.txt --max-seconds 150 --output bgm.flac
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" compose "<new style caption>" --abc-file score.abc --cot melody --lyrics-file lyrics.txt --output cover.flac
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" compose --from-plan JOB_ID --steps 32 --format wav --output rerender.wav
```

| Flag | Meaning |
|---|---|
| `<caption>` / `--caption-file` | English description (≤4000) |
| `--lyrics S` / `--lyrics-file` | tagged lyrics (≤20000) or LoRA structure tags |
| `--instrumental` | instrumental AR LoRA (cot=full, BF16, structure-only lyrics) |
| `--cot full|melody|off` | plan melody+chords / melody / no score |
| `--abc-file PATH` | use this ABC (≤50000) instead of composing one |
| `--plan-only` | score only, saved as `.abc` |
| `--from-plan JOB_ID` | exact plan re-render (no `--preset`, fixed caption/lyrics/cot/abc/seed/cfg/LoRA) |
| `--title`, `--preset balanced|draft|memory`, `--format flac|wav|mp3` | |
| `--max-seconds S` / `--max-tokens N` | cap (≈25 tokens/s, ≤9000) |
| `--seed N`, `--cfg F`, `--steps N` | reproducibility / synthesis |
| `--fp8`, `--offload-ar`, `--vae-frames 256|512|1024`, `--backend` | memory / experimental (not with LoRA) |
| `--temperature --top-p --top-k --rep-penalty`, `--abc-*` | sampling knobs — leave alone unless comparing |
| `--output PATH` | audio target; `.abc` saved beside it (`--no-score` to skip) |
| `--no-wait`, `--timeout S` (default 3600), `--idempotency-key K` | |

The dispatcher prints `JOB: … Idempotency-Key=…` (stderr), progress, `WARNING:` if the server flags a cap hit, then `SAVED: <abs> (job=…, <actual>s of cap ≈<cap>s, …)`, `SCORE SAVED: …abc`, and `PLAN: reusable — … --from-plan <id>` when applicable. Surface these lines and the **actual length** to the user.

## Step 7 — After the take

- Good melody, wrong sound → `--from-plan JOB_ID` with different `--steps`/sampling. Good sound, wrong melody → new `--seed`.
- User wants to tweak notes/chords/lyrics → `/aicowork-yue:score get JOB_ID`, edit the ABC (preserve the `X:`/`M:`/`L:`/`K:`/`V:Vocal`/`V:Ins` headers), then `--abc-file`.
- Stray vocals in an instrumental → remove any vocal words from the caption, keep structure-only tags, try another seed; total exclusion is not guaranteed.
- Cap hit → raise `--max-seconds` or trim sections; early end → richer arc in the caption, more sections, new seed.

## Edge cases

| Situation | Do |
|---|---|
| No key (exit 1) | *"Run `/aicowork-yue:config <key>` first."* |
| 401 (exit 2) | expired / revoked key → new key in Studio → API 연동. |
| 404 (exit 3) | wrong id or another member's job; plan-only / transcription jobs have no audio. |
| 409 (exit 3) | Idempotency-Key reused with different content, or source plan failed verification (check `jobs-get` → `Plan reuse`). |
| 422 (exit 4) | dispatcher names the rule; server detail otherwise — LoRA trio, off + abc, plan fields. |
| 429 (exit 5) | 8 active jobs per account — `/aicowork-yue:jobs list --status running`, wait/cancel. |
| 503 (exit 5) | engine not ready — `/aicowork-yue:status`. |
| Job failed (exit 7) | read error; OOM → memory preset / lower cap; otherwise simplify and retry once. |
| Timeout (exit 9) | job continues; `/aicowork-yue:jobs download JOB_ID` later. |
| Voice cloning / partial edits / lyric transcription requested | not offered by YuE Studio; explain, offer the cover flow instead. |
| Speech instead of music | use `/aicowork-tts:create`. |

## Time / queue note

One GPU, one job at a time, 8 active jobs per account shared with Studio and all keys. A 3-minute balanced song takes several minutes (plan + synthesis + decode); draft roughly halves synthesis only. The dispatcher polls every 3 s (API minimum) and waits up to 60 min.
