# aide-keychain-helper

Tiny TCP bridge that lets the aide gateway Docker container read the
host macOS Keychain entry `Claude Code-credentials` without giving
the container itself any privileged access.

Solves option A/B' from
[`docs/OAUTH_REFRESH_DESIGN.md`](../../docs/OAUTH_REFRESH_DESIGN.md):
when the OAuth access_token expires, aide can ask the keychain
(where the Claude Code app on the same host writes its rotated
tokens) for a fresh bundle instead of immediately calling anthropic.
This eliminates the rotation race that auto-pauses accounts with
`invalid_grant` under multi-process use.

## Why TCP, not unix socket

Docker Desktop on macOS bind-mounts unix sockets through VirtioFS,
which doesn't preserve socket inode semantics — the file appears in
the container but `connect()` returns ECONNREFUSED. TCP via
`host.docker.internal` works reliably across Docker Desktop versions
and Linux Docker Engine alike.

## Scope

- **macOS only.** Uses `/usr/bin/security find-generic-password`.
  Linux + Windows operators get nothing from this.
- **READ + WRITE.** When aide refreshes the bundle itself (anthropic
  fallback path), it pushes the new bundle back to keychain so the
  Claude Code app inherits it on its next read. Write op:
  `add-generic-password -U` with merge-existing-fields to preserve
  any non-token metadata.
- **Per-user.** Runs as the user that owns the keychain item; not a
  system-wide daemon.

## Install

```bash
cd scripts/keychain-helper
./install.sh
```

What it does:

1. Verifies node is on PATH (substitutes the absolute path into the
   plist so launchd can find it without nvm shims).
2. Generates (or reuses) a 256-bit bearer token at
   `~/.aide/keychain.token` (mode `0600`).
3. Places + loads a launchd LaunchAgent at
   `~/Library/LaunchAgents/com.hanfour.aide.keychain-helper.plist`.
4. Starts the helper listening on `127.0.0.1:47823` (override via
   `AIDE_KEYCHAIN_PORT` or `AIDE_KEYCHAIN_HOST`).
5. Waits for the port to be reachable, then prints the token path
   and a test command.

Re-run any time to pick up source changes (it unloads + reloads).
Logs land at `~/Library/Logs/aide-keychain-helper.log`.

## Uninstall

```bash
./install.sh --uninstall
```

The token file is preserved so `install.sh` round-trips don't
invalidate any container side that's already mounted it. Delete
`~/.aide/keychain.token` manually if you want a fresh token on the
next install.

## Test it manually

```bash
TOKEN=$(cat ~/.aide/keychain.token)

# expect: {"ok":true,"pong":true}
echo "{\"op\":\"ping\",\"auth\":\"$TOKEN\"}" | nc 127.0.0.1 47823

# expect: {"ok":true,"bundle":{"access_token":"sk-ant-oat01-…","refresh_token":"sk-ant-ort01-…","expires_at":"2026-…Z"}}
echo "{\"op\":\"read\",\"auth\":\"$TOKEN\"}" | nc 127.0.0.1 47823
```

The first time `read` runs after a fresh login, macOS may show a
keychain access prompt. Tick "Always Allow" so launchd can run the
helper unattended thereafter.

## Wire format

Newline-delimited JSON. Each request must include `auth` matching
the bearer token in `~/.aide/keychain.token`.

| op | request | response |
|---|---|---|
| `ping` | `{"op":"ping","auth":"…"}` | `{"ok":true,"pong":true}` |
| `read` | `{"op":"read","auth":"…"}` | `{"ok":true,"bundle":{access_token,refresh_token,expires_at}}` |
| `write` | `{"op":"write","auth":"…","bundle":{access_token,refresh_token,expires_at}}` | `{"ok":true}` |
| (any) on auth fail | — | `{"ok":false,"error":"unauthorized"}` |
| (any) on other error | — | `{"ok":false,"error":"…"}` |

`write` merges the supplied tokens into the existing keychain entry,
preserving any non-token fields (subscriptionType / scopes / etc.)
the Claude Code app may have written. Invalidates the helper's
internal read cache so the next `read` sees the new value.

## Container wiring

`docker/docker-compose.yml` mounts the token (read-only) into the
gateway container and configures the env knobs:

```yaml
environment:
  GATEWAY_KEYCHAIN_HELPER_ENDPOINT: host.docker.internal:47823
  GATEWAY_KEYCHAIN_HELPER_TOKEN_PATH: /run/aide-keychain.token
volumes:
  - ${HOME}/.aide/keychain.token:/run/aide-keychain.token:ro
extra_hosts:
  - "host.docker.internal:host-gateway"
```

When the env is unset or the token file is empty/missing, the
gateway falls back to its existing direct-anthropic refresh path —
the helper is opt-in.

## Security notes

- The token file is `0600` and the parent directory is `0700`. Only
  the user (or root) can read the token.
- The helper listens on `127.0.0.1` by default — only local processes
  can reach the port.
- Anyone who can read the token already has the same UID as the
  keychain owner, so they could run `security find-generic-password`
  themselves — exposing it via TCP+token adds no extra privilege.
- Constant-time token comparison; idle connection timeout 5s.
- The helper does not log token contents or bundle contents. It
  logs `op` + outcome only.
