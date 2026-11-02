---
description: Cover flow for AICowork YuE Studio — upload an existing recording, transcribe it to an ABC score with SheetSage2, review warnings, optionally strip chords, then hand the score to /aicowork-yue:create for a new arrangement with new lyrics and style
argument-hint: '<audio file> [with chords] [title] [then: new style / lyrics for the cover]'
allowed-tools: Bash(node:*), Write
---

# Cover (aicowork-yue)

A cover in YuE Studio is **score-conditioned regeneration**: the recording is transcribed to a two-voice ABC score (`V:Vocal`, `V:Ins`), and a brand-new piece is generated from that score with a new caption, new lyrics and a new style. It does **not** clone the original singer, keep the original backing, replace only some bars, or transcribe lyrics — say so once if the user expects any of those.

## Step 1 — Parse `$ARGUMENTS`

- **Audio file path** (`.wav .flac .mp3 .m4a .ogg .opus .aac`) → the upload. Limits: ≤90 MiB **original file**, real length 0.1–600 s. Longer → ask the user to trim first (the server does not auto-cut).
- **Chords wanted** (`코드도`, `화성 유지`, `with chords`) → `--chords` (melody_only=false). Default keeps vocal + instrument melodies and drops chord symbols — the right start for a re-harmonized cover.
- **Title** → `--title`.
- **Cover direction** (new genre, instruments, mood, lyrics) → carried into Step 3.

## Step 2 — Transcribe

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" transcribe <audio> [--title T] [--chords] [--output score.abc] [--source-wav normalized.wav]
```

- Raw-bytes upload, **no Idempotency-Key** on this path: if the reply is lost, check `/aicowork-yue:jobs list --kind transcription` **before** uploading again — a retry may create a second job.
- The dispatcher waits (same queue as generation), prints `TRANSCRIPTION WARNING:` lines (tempo estimate, uncertain bars…), `TRANSCRIBED: job=… source Ns`, and `SCORE SAVED: <path>.abc`. `--source-wav` also saves the server's normalized 48 kHz stereo WAV (not the original bytes).
- 413 → file over 90 MiB; 422 → unsupported format / length; 503 → transcription engine not ready.

## Step 3 — Review and prepare the score

1. Open the `.abc` and read the warnings. Automatic transcription has pitch/rhythm/chord errors — point the user to obvious ones (odd tempo, empty `V:Ins`, repeated bars).
2. Optional checks with `/aicowork-yue:score`:
   - `inspect score.abc` → BPM, voices, bars, nominal length (differs from real audio length).
   - `strip score.abc --keep both|Vocal|Ins` → removes chord symbols; choosing one voice turns the other into rests (not audio separation). Needed if the transcription kept chords (`--chords`) but the cover should get a new harmony.
   - `compare before.abc after.abc` after manual edits → confirms melody/timing preserved (`allow-tempo-change` if you changed tempo on purpose).
3. Keep the ABC headers intact when editing (`X:`, `M:`, `L:`, `K:`, `V:Vocal`, `V:Ins`); the checker only understands YuE's limited two-voice dialect.

## Step 4 — Generate the cover

Hand off to `/aicowork-yue:create` semantics with the score attached:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" compose "<new style caption>" --abc-file score.abc --cot melody --lyrics-file lyrics.txt --title "<title> (cover)" --output cover.flac
```

- Caption = the **new** style (e.g. *"Jazz-funk, warm lead vocal, Rhodes piano, electric bass, tight drums, relaxed groove, complete ending"*).
- Lyrics = the **user's** words with section tags (the service does not transcribe lyrics). For an instrumental cover leave lyrics empty and say *"instrumental, no vocals"* in the caption — the instrumental **LoRA cannot be combined with a chord-stripped/melody ABC**, so plain mode is the path here.
- `--cot melody` follows the melody; `--cot full` if the ABC still carries chords you want honoured. `--cot off` cannot take an ABC.
- A transcription job id is **not** a valid `--from-plan` source; only creation jobs are.

Report the `SAVED:` / `SCORE SAVED:` lines, the actual length, and remind the user the result is a new performance, not an edit of the original.

## Later

- `/aicowork-yue:jobs score TRANSCRIPTION_ID` re-downloads the extracted ABC; `jobs source-audio ID` the normalized WAV; `jobs get ID` the warnings.
- Transcription jobs count toward the 8-active-jobs limit and appear in the library as `[transcription]` with no audio of their own.
