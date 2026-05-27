# caliber-agent

Go single-binary daemon that ships LLM coding-session telemetry from local
Claude / Codex transcripts to a caliber instance.

**Status (PR4):** scaffolding, interactive `enroll`, watcher, ingest,
redaction, and all subcommands shipped. Daemon is foreground-only (no
launchd). Manual start/stop via `caliber-agent run` + Ctrl+C; pause/resume
via subcommands.

## Install

```sh
brew install hanfour/caliber/caliber-agent  # once the tap is published
# or download a release binary:
curl -L https://github.com/hanfour/caliber/releases/download/agent/v0.1.0/caliber-agent-agent_v0.1.0-darwin-arm64.tar.gz | tar -xz
```

## Enrol a device

1. In the caliber web UI, go to `/dashboard/devices` and click "Issue
   enrollment token". Copy the token.
2. Run:

   ```sh
   CALIBER_API_BASE_URL=https://your-caliber.example caliber-agent enroll <token>
   ```

The interactive wizard prompts for which project paths to watch. The
default is **none** — caliber-agent will not upload anything until you
explicitly add paths. This is a deliberate privacy contract.

## Environment Variables (full reference)

| Env | Effect | When read |
|---|---|---|
| `CALIBER_AGENT_HOME` | Overrides `~/.caliber-agent` config / state / log directory | Every subcommand startup |
| `CALIBER_API_BASE_URL` | Default API base URL when `--api-base-url` is omitted | **Only `enroll`** (`run` reads from `config.toml`) |
| `CALIBER_CLAUDE_PROJECTS` | Overrides `~/.claude/projects` watch root (advanced / dev) | `enroll` wizard scan + `run` startup |
| `CALIBER_CODEX_SESSIONS` | Overrides `~/.codex/sessions` watch root (advanced / dev) | `run` startup |

## Lifecycle

`caliber-agent` runs as a **foreground** process: you start it yourself
(`caliber-agent run`), and stop it with Ctrl+C. There is no auto-start. To
pause without killing the daemon, use `caliber-agent pause`; resume with
`caliber-agent resume`.

## Uninstall

`caliber-agent uninstall` performs three steps in order:

1. **Revoke remote** — calls `DELETE /v1/devices/me` so the server marks
   this device's API keys revoked.
2. **Remove keychain entry** — `tw.caliber.agent` / `<device_id>`.
3. **Delete `~/.caliber-agent/`** — config, state, redaction-set cache,
   agent.log, lockfile, and the in-progress uninstall sentinel.

Useful flags:

- `--yes` — skip the consent prompt (required in non-TTY shells / CI).
- `--keep-remote` — skip step 1 (device already revoked via web UI, or
  server unreachable).
- `--force` — proceed even if a `caliber-agent run` daemon is currently
  active (the daemon will self-exit on its next sentinel/config check).

If uninstall is interrupted mid-cleanup (e.g. SIGINT after step 5):
re-running `caliber-agent uninstall` is **safe** while `config.toml`
still exists; if it doesn't, manually `rm -rf ~/.caliber-agent/` and
revoke the device in the caliber web UI.

## Build from source

```sh
git clone https://github.com/hanfour/caliber
cd caliber/agent
go build -o caliber-agent ./cmd/caliber-agent
```

## Release tag pattern

The agent uses its own tag namespace `agent/v*` so it can be released on
a separate cadence from the main caliber server.
