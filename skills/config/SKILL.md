---
description: Manage the AICowork YuE Studio API key for aicowork-yue — save, show, or clear
argument-hint: '[<yue_... key> | clear]'
allowed-tools: Bash(node:*)
---

# Config (aicowork-yue)

Manage the personal YuE Studio API key used by every `create`, `cover`, `score` and `jobs` call.

## Three forms

Parse `$ARGUMENTS`:

- **Empty** → call `config-show`.
- **Single token equal to `clear`** (case-insensitive) → call `config-clear`.
- **Anything else** (a key, normally `yue_...`) → call `config-set` with it.

```bash
# Show current state (masked):
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" config-show

# Save a key:
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" config-set "yue_..."

# Clear the saved key:
node "${CLAUDE_PLUGIN_ROOT}/scripts/aicowork-yue.mjs" config-clear
```

Show the dispatcher stdout verbatim. The dispatcher masks the key automatically, so it is safe to surface. Never echo the full key back in your own words.

## Where is the key stored?

- Windows: `%APPDATA%\aicowork-yue-in-cc\config.json`
- macOS / Linux: `$XDG_CONFIG_HOME/aicowork-yue-in-cc/config.json` or `~/.config/aicowork-yue-in-cc/config.json`
- File permissions: `0600` on POSIX.

## Priority

The `YUE_API_KEY` environment variable always wins over the config file — it is the same variable the studio's official Python client reads. `YUE_BASE_URL` (also shared with the official client) overrides the server; default `https://yue.aicowork.cc`.

## Where to get a key

YuE Studio (web) → **API 연동** → **새 API 키** → name + expiry (30 d / 90 d / 1 y / never) → create. The full key is shown **once**; copy it then. Revoke unused keys there. The Studio login password is not an API key; keys stop working when expired, revoked, or when the account is deactivated.

## Common follow-up

After `config-set`, suggest `/aicowork-yue:status` to confirm `Ready: yes`, the account name, and `Engine: online`.
