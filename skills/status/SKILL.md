---
description: Diagnostic for aicowork-yue-in-cc — Node version, plugin version, API key state, live key check, engine online / my queue / GPU, library size; add "settings" for live defaults, presets, ranges, models, capabilities and limits
argument-hint: '[settings]'
allowed-tools: Bash(node:*)
---

# Status (aicowork-yue)

Reports Node version, plugin version, server URL, API key resolution source (env / config-file / none), masked key, and — when a key is present — a **live, non-billable** check: `GET /api/v1/me` (account), `GET /api/v1/status` (engine online, my queued/running counts, GPU), `GET /api/v1/jobs` (library size by status and kind).

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" status
```

If `$ARGUMENTS` contains `settings` / `설정` / `프리셋` / `범위` / `기본값` / `모델`, also run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" settings
```

Show the dispatcher stdout to the user verbatim. Interpret for the user:

- `Ready: no` → *"No API key configured. Run `/aicowork-yue:config <your-key>` or set `YUE_API_KEY`."*
- `API check: FAILED (HTTP 401)` → key expired / revoked / account deactivated; issue a new key in Studio → API 연동.
- `Engine: online, queue N, running M (mine)` → `online` means submissions will run. The counts are **this account's** jobs and count toward the 8-active-jobs limit (429 when exceeded). `OFFLINE` → wait before submitting; transcription has its own engine and may return 503 separately.
- `Library: N jobs (… , K transcription)` → transcription jobs have no audio; failed/cancelled entries can be hidden with `/aicowork-yue:jobs delete`.
- `settings` output → live defaults (cot full, 9000-token cap, cfg 1.0, 32 ODE steps, BF16, 1024-frame decoding, flac…), the three presets (`balanced` / `draft` / `memory`) and what they override, numeric ranges, text limits (caption 4000, lyrics 20000, ABC 50000), installed models (YuE2-3B, YuE2-Vae, the instrumental LoRA), `capabilities` (`exact_duration=false`, plan, external_abc, instrumental_lora, 48 kHz stereo) and `limits` (concurrency 1, 8 active jobs per user). If a range here differs from the create skill's tables, trust the live output.
