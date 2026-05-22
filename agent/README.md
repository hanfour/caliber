# caliber-agent

Go single-binary daemon that ships LLM coding-session telemetry from local
Claude / Codex transcripts to a caliber instance.

**Status (PR1):** scaffolding + interactive `enroll`. Watcher, ingest,
launchd, and the remaining commands land in subsequent PRs.

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

## Environment

- `CALIBER_AGENT_HOME` — config root, defaults to `~/.caliber-agent`
- `CALIBER_API_BASE_URL` — caliber API URL (required during `enroll`)

## Build from source

```sh
git clone https://github.com/hanfour/caliber
cd caliber/agent
go build -o caliber-agent ./cmd/caliber-agent
```

## Release tag pattern

The agent uses its own tag namespace `agent/v*` so it can be released on
a separate cadence from the main caliber server.
