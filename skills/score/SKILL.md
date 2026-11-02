---
description: ABC score tools for AICowork YuE Studio — download a job's score, inspect its structure (BPM, voices, bars, nominal length), strip chord symbols for a re-arrangement, compare a score before and after editing, and hand an edited ABC back to /aicowork-yue:create
argument-hint: '[get JOB_ID | inspect file.abc | strip file.abc [Vocal|Ins] | compare before.abc after.abc]'
allowed-tools: Bash(node:*), Read, Write, Edit
---

# Score (aicowork-yue)

YuE plans music as an **ABC score** (text notation, two voices `V:Vocal` and `V:Ins`) before synthesizing audio. This command wraps the CPU-only score tools and the score download. Editing the ABC and regenerating gives a **new** piece — nothing here edits an existing recording.

## Parse `$ARGUMENTS`

| User intent | Subcommand |
|---|---|
| `악보 받아`, `ABC 보여줘` + job id | `jobs-score JOB_ID [--output PATH]` |
| `검사`, `구조 확인`, `몇 BPM`, `몇 마디` + `.abc` | `score-inspect file.abc [--json]` |
| `코드 제거`, `멜로디만`, `새 편곡용` + `.abc` (+ `보컬만` / `악기만`) | `score-strip file.abc [--keep both\|Vocal\|Ins] [--output PATH]` |
| `비교`, `바뀐 거 확인`, `템포 바꿨어` + two `.abc` | `score-compare before.abc after.abc [--voices Vocal,Ins] [--allow-tempo-change]` |
| `악보 고쳐서 다시 만들어` | edit the file (Read/Edit tools), then `/aicowork-yue:create … --abc-file edited.abc` |

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" jobs-score JOB_ID --output song.abc
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" score-inspect song.abc
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" score-strip song.abc --keep both --output song-melody.abc
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" score-compare song.abc song-edited.abc --voices Vocal
```

Show stdout verbatim (`SCORE SAVED:`, `INSPECTION:`, `INVARIANTS:`, `MATCH:` / `DIFFERENCES:`). `--json` returns the raw tool response.

## What the agent must know

- **Dialect:** the tools understand only YuE / SheetSage2's limited two-voice ABC. A 422 means "outside that dialect or structurally suspect", not "invalid ABC". Keep headers (`X:`, `T:`, `M:`, `L:`, `Q:`, `K:`, `V:Vocal`, `V:Ins`) and bar structure when editing; change pitches/durations/chords inside bars.
- **Inspect** reports BPM, unit note length, per-voice notes/chords/key/bars and `nominal_duration_seconds` — the score's arithmetic length, which differs from the audio the model will actually produce.
- **Strip chords** removes chord symbols so the new caption's harmony takes over. `--keep both` (default) keeps both melodies; `--keep Vocal` or `Ins` turns the other voice into rests on the same time grid. It is **not** audio source separation, and it does not save anything server-side. Stripping implies `--cot melody` for the follow-up generation; the instrumental LoRA (which needs `cot=full`) cannot be used with a stripped score — use plain mode with an "instrumental, no vocals" caption instead.
- **Compare** checks pitch, onset, duration, bars and tempo of the chosen voices; chord differences are ignored. `match: true` means the selected voices agree on paper, not that the synthesized audio will match. Pass `--allow-tempo-change` when a tempo change was intentional.
- **Sizes:** ABC 1–50,000 chars. Scores from `cot=off` jobs do not exist (`jobs-score` exits 3).
- **Hand-off:** after editing, always run `score-compare` (original vs edited) so the user sees exactly what changed, then `/aicowork-yue:create "<caption>" --abc-file edited.abc --cot melody|full --lyrics-file lyrics.txt`. Do not add the generated `score.abc` to a `--from-plan` request — exact re-renders reuse the saved plan tokens, not the text.
- The ABC is plain text; there is no staff rendering in Studio or here. If the user wants to "see" the melody, describe it (key, range, contour, bar count) from the inspection.
