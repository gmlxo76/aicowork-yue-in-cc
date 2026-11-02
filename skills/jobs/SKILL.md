---
description: Manage the AICowork YuE Studio library — list creation/transcription jobs, show a job's settings/seed/warnings/plan-reuse status, download audio and score (also for jobs that outlived the create timeout), fetch the native bundle ZIP / resubmit JSON / artifacts / source WAV, rename or favorite, cancel, delete
argument-hint: '[list [검색어] [status] | get JOB_ID | download JOB_ID [out] | bundle JOB_ID | workflow JOB_ID | artifact JOB_ID name | source-audio JOB_ID | rename JOB_ID "제목" | favorite JOB_ID | cancel JOB_ID | delete JOB_ID]'
allowed-tools: Bash(node:*)
---

# Jobs (aicowork-yue)

Every `/aicowork-yue:create` or `:cover` run is a server-side job (`kind` = `creation` or `transcription`) that also appears in the user's 내 음악. Use this command to inspect what a job actually used, fetch results later, reuse plans, or tidy the library.

## Parse `$ARGUMENTS`

| User intent | Subcommand |
|---|---|
| `목록`, `내 음악`, empty | `jobs-list [--q TEXT] [--status S] [--kind creation\|transcription] [--limit N]` |
| `설정`, `시드`, `경고`, `계획 재사용 가능?` + id/title | `jobs-get JOB_ID` |
| `다운로드`, `받아줘`, `타임아웃 난 거` | `jobs-download JOB_ID [--output PATH] [--no-score]` (audio + `.abc`; score only for plan jobs) |
| `악보만` | `jobs-score JOB_ID [--output PATH]` (see `/aicowork-yue:score`) |
| `전체 결과 ZIP`, `네이티브 파일`, `plan.json` | `jobs-bundle JOB_ID [--output PATH]` |
| `요청 JSON`, `다시 제출용` | `jobs-workflow JOB_ID [--output PATH]` |
| `request.json` / `config.json` / `result.json` / `score.abc` 개별 | `jobs-artifact JOB_ID <name>` |
| `업로드한 원본`, `보관 음원` (transcriptions) | `jobs-source-audio JOB_ID [--output PATH]` |
| `제목 바꿔`, `즐겨찾기` | `jobs-edit JOB_ID --title T` / `--favorite true\|false` |
| `취소`, `멈춰` | `jobs-cancel JOB_ID` |
| `삭제`, `숨겨` | `jobs-delete JOB_ID` — **confirm first** |

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" jobs-list --limit 20
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" jobs-get JOB_ID
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" jobs-download JOB_ID --output ./aicowork-yue/song.flac
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" jobs-bundle JOB_ID
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" jobs-edit JOB_ID --favorite true
```

Show stdout verbatim. `--json` on list/get returns raw MusicJob fields.

## Interpretation

- `JOB:` lines show kind (`song` / `instrumental` / `plan` / `transcription`), actual seconds, format, `+abc` when a score exists, `plan✓` when `exact_plan_reusable`, `⚠` when the server attached a warning (usually the token cap was hit), `★` favorite.
- `jobs-get` → `Length: Ns of cap ≈Ms (T tokens)`: the cap is an upper bound; a result at ~the cap was truncated, one far below it ended naturally. `Seed:` shows the seed actually used (`(was random)` if drawn at run time) — quote it for reproduction. `Plan reuse: yes — compose --from-plan ID` means the native plan can be re-rendered exactly via `/aicowork-yue:create --from-plan`.
- **Downloads:** audio uses the job's own `format`; the sibling `.abc` is saved unless `--no-score`. Plan-only jobs yield only the `.abc`; transcription jobs yield `.abc` (+ `source-audio` WAV, which is the normalized 48 kHz stereo copy, not the original bytes). Exit 9 = still running; exit 7 = failed/cancelled.
- **Bundle** ZIP: `request/config/result.json`, `score.abc`, plan files (`plan.json`, `plan_manifest.json`, `abc_tokens.npy`, `prefix.npy`), `semantic.npy`, `latent.npy`, `audio.flac` (+ wav/mp3 if chosen) — whatever exists. ≤512 MiB; excludes uploaded source audio. Keep the four plan files together to reproduce a plan outside Studio.
- **Workflow** here is the **Studio resubmit request JSON** with the actual seed (not a ComfyUI graph): it recreates the *input conditions*, not necessarily the same auto-composed plan; use `--from-plan` for that.
- Cancel: queued stops now, running stops after the current stage. **Delete hides the job and its files from the library** (local files stay). Confirm, and cancel first if still running.
- 404 = wrong id or another member's job; 409 on plan reuse = the source plan failed verification.
- The account may hold 8 active (queued + running) jobs across Studio and all keys; transcriptions count too.
