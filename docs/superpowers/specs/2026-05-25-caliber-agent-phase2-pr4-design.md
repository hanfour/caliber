---
title: caliber-agent Phase 2 PR4 — Subcommand wire-up + compliance hardening
date: 2026-05-25
authors: hanfour + claude
status: draft
supersedes: docs/superpowers/specs/2026-05-23-caliber-agent-phase2-pr3-design.md §10 (PR4 table)
---

# caliber-agent Phase 2 PR4 — Subcommand wire-up + compliance hardening

## 1. Goals + Non-Goals

### Goals

1. **6 個子命令落地**: `add-path` / `remove-path` / `pause` / `resume` / `status` / `uninstall` 從 `ExitNotImplemented` 換成真實作。
2. **移除 `set-mode` 子命令**: 從 `root.AddCommand` 拿掉、刪檔 + 對應測試。Mode 切換改由直接編輯 `config.toml` + 重啟 `run` 的流程；PR3 OBS-2 已建立的 startup mode allowlist 仍守住。
3. **合規硬化 audit 必修 9 項**: symlink 防護、HTTPS scheme 強制、regex 上限、PersistentFlag 限縮、文案修正、env 變數文件化 — 全部對應 audit report 條目。
4. **Server side `DELETE /v1/devices/me`**: 給 daemon `uninstall` 呼叫，cda_* Bearer auth、軟撤銷 device、寫 audit log。
5. **Phase 2 完成定義收斂**: parent spec `multi-source-ingest-design.md` §549 原本的 "daemon dogfood: h4 + mac-mini both running it" 改為 "daemon 可手動 foreground 啟動，子命令 + 合規硬化齊備，可在 h4 上手動執行做為 dogfood"。`launchd` 自動啟動從 Phase 2 範圍**移除**（不延後、是 dropped），與 Anthropic Usage Policy 的網路安全違規攔截守則對齊。

### Non-Goals

- 不寫 launchd plist、不安裝 LaunchAgent、不接觸 `~/Library/LaunchAgents/`
- 不寫 `~/.zshrc` / `~/.bash_profile` / shell PATH
- 不改其他目錄權限、不請求 Full Disk Access、不動 TCC
- 不做 `set-mode` 子命令
- 不做 TLS certificate pinning（延 Phase 3）
- 不做 `agent.log` rotation（延 Phase 3）
- 不做 cross-session batching（延 Phase 3）
- 不做 Linux build（延 Phase 5+）

### Anthropic Usage Policy 對齊

PR4 完成後 caliber-agent 對齊以下違規攔截類別：

| 類別 | 對應設計 |
|---|---|
| Malware / Persistence | 無 launchd、無 LaunchAgent；user 手動 foreground 啟動 |
| Spyware / Stalkerware | `add-path` 印 consent banner；零後台網路 side-effect 的子命令；agent.log 透明可審 |
| Privilege escalation | 無 sudo / setuid / TCC；keychain 只存取自己寫入的 entry |
| Command hijacking | 無 PATH 修改；keychain shell-out 用絕對路徑 `/usr/bin/security` |
| Credential / secret theft | 監看範圍嚴格限定使用者 add-path 的路徑；redaction 必過；symlink 拒收 |
| Unauthorized data exfiltration | URL 凍結於 config.toml；`uninstall` 主動撤銷遠端 device |
| Anti-forensics / Detection evasion | uninstall 印實際刪除清單；agent.log 不混淆、不自我刪除 |
| Code execution from server | RedactionSet 響應只解 typed JSON；regex 上限；無遠端命令通道 |

## 2. Scope Summary

| 層 | 項目 | 動作 | 檔案 |
|---|---|---|---|
| agent CLI | `add-path` 落地 | 新實作 | `agent/internal/cli/addpath.go` |
| agent CLI | `remove-path` 落地 | 新實作 | `agent/internal/cli/removepath.go` |
| agent CLI | `pause` 落地 | 新實作 | `agent/internal/cli/pause.go` |
| agent CLI | `resume` 落地 | 新實作 | `agent/internal/cli/resume.go` |
| agent CLI | `status` 落地 | 新實作 | `agent/internal/cli/status.go` |
| agent CLI | `uninstall` 落地 | 新實作 | `agent/internal/cli/uninstall.go` |
| agent CLI | `set-mode` 移除 | 刪檔 + 從 root 移除 | `agent/internal/cli/setmode.go`（刪）、`root.go:41`（移除 AddCommand） |
| agent CLI | `--api-base-url` PersistentFlag → enroll-only | flag scope 縮小 | `agent/internal/cli/root.go`、`agent/internal/cli/enroll.go` |
| agent CLI | `run` short desc 修正 | 文字修正 | `agent/internal/cli/run.go:29` |
| agent CLI | `--insecure` 新 flag（enroll only） | 新加 flag | `agent/internal/cli/enroll.go` |
| agent watcher | symlink 防護 | 新邏輯 | `agent/watcher/loop.go`、`agent/watcher/claude.go`、`agent/watcher/codex.go`、`agent/internal/cwdresolve/cwdresolve.go` |
| agent watcher | pause sentinel 檢查 | tick 開頭加 stat | `agent/watcher/loop.go:Tick` |
| agent watcher | tick 開頭 + 每 SendChunk 前驗 .uninstalling + config + lock（F2/F5/R3） | stat + flock 探測 | `agent/watcher/loop.go:Tick` 與 chunk loop |
| agent CLI | run lockfile acquire + PID 寫入（F2 + R2-F4） | 啟動 flock 持有 + PID 寫入 | `agent/internal/cli/run.go`、新 `agent/internal/lockfile/lockfile.go`（或 darwin-only `lockfile_darwin.go`） |
| agent CLI | uninstall 寫 `.uninstalling` sentinel + 失敗時還原（R3-F2） | 新 sentinel 機制 | `agent/internal/cli/uninstall.go` |
| agent redact | bootstrap/refresher 對 `ErrTooManyPatterns` 走 fallback（F3） | 既有 fail-open 修補 | `agent/internal/cli/redactionset.go`、`agent/internal/cli/run.go` (refresher goroutine) |
| **server REST** | `resolveDeviceFromAuthAllowRevoked` 變體（F1） | 既有 helper 旁加 sister fn | `apps/api/src/rest/ingestAuth.ts` |
| agent config | IncludePaths 正規化 | enroll/add-path 寫入前 EvalSymlinks + Clean | `agent/internal/config/config.go` 或新 `paths_normalise.go` |
| agent config | HTTPS scheme 驗證 | enroll wizard + Load 加驗 | `agent/internal/cli/enroll.go`、`agent/internal/wizard/enroll.go`、`agent/internal/config/config.go` |
| agent config | `insecure_transport` 新欄位 | schema 擴充 | `agent/internal/config/config.go` |
| agent redact | regex 長度 / 數量上限 | `Pattern.Compile()` 前驗 | `agent/redact/regexes.go`、`agent/redact/set.go` |
| agent api | `Client.RevokeSelf(ctx, token)` | 新方法 | `agent/internal/api/revoke.go`（新檔） |
| agent README | env 變數文件化 | 新章節 | `agent/README.md` |
| **server REST** | `DELETE /v1/devices/me` | 新 endpoint | `apps/api/src/rest/devicesRevokeSelf.ts`（新檔）、`apps/api/src/server.ts`（註冊） |
| server tests | `devicesRevokeSelf.test.ts` 整合測試 | 新檔 | `apps/api/tests/integration/rest/devicesRevokeSelf.test.ts` |
| server | audit log action `device.self_revoked` | 加 action type enum | audit log action 定義處 |

預期 ~12–15 phases of subagent-driven-development、~30+ raw commits、merge 時 squash。

### PR1 既有行為的相容性影響

下列是必須提前說明的 breaking-ish 變更：

1. `IncludePaths` 在 enroll wizard / add-path 寫入前做 `filepath.EvalSymlinks` + `Clean` — 改變 PR1 wizard 既有行為（PR1 直接寫使用者輸入字串）。
2. `set-mode` 子命令的 stub 測試（`agent/internal/cli/stubs_test.go` 內對 `set-mode` 的部分）一併刪除。
3. `--api-base-url` 從 PersistentFlag 移到 enroll 子命令的 local flag — 影響 `root_test.go` 的 flag-presence 測試。
4. PR1 既存的 `config.toml` 若包含未正規化 path，PR4 啟動**不會** retro-normalise — 詳見 §4。

## 3. CLI Surface 細節

### 3.1 `caliber-agent add-path <absolute-path>`

```
args:  1 (absolute path)
flags: --yes  (跳過互動確認，給腳本用)
```

行為：

1. 驗 `<path>` 是絕對路徑且 stat 存在且是目錄。
2. `filepath.EvalSymlinks(path)` + `filepath.Clean` 正規化。
3. 讀 `config.toml`；若 normalised path 已在 `IncludePaths`，print `already in list` 並 `exit 0`。
4. 印 consent banner：

   ```
   This will watch <normalised-path> and upload transcript content found under
   it to <api_base_url>. Mode: <mode>. Continue? [y/N]
   ```

   `--yes` 跳過互動。非 TTY 場景見 §11 R7。
5. append 後 atomic save（既有 PR1 pattern: tmp + chmod 0600 + rename）。
6. 印 `[ok] added <path>; restart 'caliber-agent run' to pick it up`.

退出碼：0 成功 / 1 path 無效或 IO 失敗 / 64 args 錯誤 / 130 user cancel 或 non-TTY without `--yes`

### 3.2 `caliber-agent remove-path <path>`

```
args:  1
flags: (none)
```

行為：

1. 嘗試 `filepath.EvalSymlinks(path)` + `Clean` 正規化。**若 path 已不存在於 disk，跳過 EvalSymlinks**，直接 `Clean(input)`（user 想清理已刪目錄的 entry，不該被 stat 卡住）。
2. 若 normalised path 不在 `IncludePaths` 印 `not in list` `exit 0`.
3. 移除並 atomic save，印 `[ok] removed <path>`.

退出碼：0 / 1 / 64

### 3.3 `caliber-agent pause`

```
args:  none
flags: (none)
```

行為（**all read-only checks before any write**）：

1. `os.Stat(~/.caliber-agent/)` 回 `ErrNotExist` → `[fatal] not enrolled` exit 1。**不 MkdirAll**
2. `os.Stat(~/.caliber-agent/.uninstalling)` 套用 sentinel fail-closed 規則（存在 / 非 ErrNotExist 錯誤）→ `[fatal] uninstall in progress; refusing to pause` exit 1（不寫 paused — 不該在 uninstall 期間建立新訊號）
3. `os.Stat(~/.caliber-agent/config.toml)` `ErrNotExist` → `[fatal] not enrolled (config.toml missing)` exit 1
4. `os.WriteFile(~/.caliber-agent/paused, []byte{}, 0o600)`
5. 印 `paused. running daemon will skip ticks on next interval. resume with 'caliber-agent resume'.`

退出碼：
- 0 — 成功（含重複 pause idempotent）
- 1 — 未 enroll / uninstall 進行中 / 罕見 IO failure

### 3.4 `caliber-agent resume`

```
args:  none
flags: (none)
```

行為：

1. `os.Remove(~/.caliber-agent/paused)`。`ErrNotExist` 印 `not paused` `exit 0`.
2. 印 `resumed.`

退出碼：0

### 3.5 `caliber-agent status [--json]`

```
args:  none
flags: --json   機器可讀輸出
```

行為（**零網路呼叫**，純讀本地）：

human-readable：

```
caliber-agent v0.3.0
device_id:    d_HxKp...
api_base_url: https://caliber.h4.example
mode:         metadata-only
paused:       no
watched paths (2):
  - /Users/h/work/foo
  - /Users/h/work/bar
state:        3 files tracked, last sync 2026-05-25T08:32:11Z
```

JSON：

```json
{
  "version": "0.3.0",
  "device_id": "d_HxKp...",
  "api_base_url": "https://caliber.h4.example",
  "insecure_transport": false,
  "mode": "metadata-only",
  "paused": false,
  "watched_paths": ["/Users/h/work/foo", "/Users/h/work/bar"],
  "files_tracked": 3,
  "last_sync": "2026-05-25T08:32:11Z"
}
```

退出碼：0 / 1（未 enroll — `config.Load() == ErrNotEnrolled`）

### 3.6 `caliber-agent uninstall`

```
args:  none
flags: --yes          跳過互動確認
       --keep-remote  跳過 server-side revoke（已從 web UI revoke / token 失效 / 離線）
       --force        即使偵測到 daemon 正在跑也強制 uninstall（不建議）
```

行為：

1. **Running-daemon detection (no-create, no-acquire probe)**：
   - 嘗試 `os.OpenFile(~/.caliber-agent/.lock, os.O_RDWR, 0)`（**不帶 O_CREATE**）
     - `ErrNotExist` → 沒有 daemon 在跑且檔案不存在；**繼續 step 2**，不留 side effect
     - 開啟成功 → `syscall.Flock(fd, LOCK_EX | LOCK_NB)` 試 acquire，**不論結果立即 close fd**（uninstall 不持有 lock）
   - flock 成功（且立即釋放）= 沒有 daemon 在跑 → 進 step 2
   - flock 失敗（已被 daemon 持有）：
     - 讀 `.lock` 內容取得 PID 印：
       ```
       caliber-agent run is currently active (PID <n>).
       Stop it first with Ctrl+C (or `kill <n>`), then re-run uninstall.
       Or pass --force to signal the daemon to exit and proceed with cleanup.
       ```
     - 若讀 PID 失敗（檔案空 / 損壞）省略 `(PID <n>)`
     - exit 1，除非 `--force`
   - `--force` 路徑：**不** acquire lock（daemon 持有，不可能拿到）。改為依賴 step 3 sentinel
   - **重要**：probe 不用 `O_CREATE`，所以 uninstall **永遠不會** 建立 `.lock`；user 取消時無 stale 空 `.lock` 殘留，符合「user cancel → 0 file-system side effect」契約

2. **顯示影響範圍 + 等待確認**：

   ```
   This will:
     1. Revoke this device at <api_base_url> (DELETE /v1/devices/me)
     2. Remove ~/.caliber-agent/ (config, state, redaction-set, agent.log, .lock, .uninstalling)
     3. Remove keychain entry: tw.caliber.agent / <device_id>
   Continue? [y/N]
   ```

   - `--yes` 跳過 prompt 直接視為 yes
   - 非 TTY 場景見 §11 R7
   - **user 選 N / non-TTY 沒 `--yes`** → exit 130，**0 file-system / network / keychain side effect**（尚未寫 sentinel、尚未呼叫 server、尚未動 keychain）

3. **`.uninstalling` stop sentinel（user 確認後才寫）**：
   - 只在 user 確認 yes（或 `--yes`）後才 `os.WriteFile(~/.caliber-agent/.uninstalling, []byte{}, 0o600)`
   - **時機 trade-off**：sentinel 寫在 prompt 之後，意味著 user 讀 prompt + 思考的數秒到數十秒內，running daemon（若 `--force` 場景）**可能仍送出少量 chunks**。這是有意取捨：
     - 優先保證「cancel = 0 side effect」（單純按錯指令不會 stop 跑得好好的 daemon）
     - prompt 時段 daemon 上傳延續其原本行為（user 還沒打 uninstall 之前 daemon 本來就在上傳），不是 uninstall 引入的新 side effect
     - 真正的 cleanup race window（remote revoke + keychain + ordered delete 期間）仍受 sentinel 完整保護
   - daemon 每 chunk 前檢查此 sentinel，存在則 `[fatal] uninstall in progress; aborting` exit 0
   - sentinel 會在 step 6 ordered delete 的最後一個 entry (g) 被清除（不需額外 cleanup）

4. **遠端 revoke**（除非 `--keep-remote`）：best-effort
   - 204 / 410：印 `[ok] device revoked at server` / `[ok] device already revoked at server`
   - 401 / 403 / network / 5xx：印 `[warn] remote revoke failed: <reason>; continuing local cleanup` 並**繼續**

5. **keychain 清理**：`keychain.Delete(deviceID)`。
   - `ErrNotFound`：視為已清，印 `[ok] keychain entry already absent` 繼續
   - **其他錯誤**：印 `[error] keychain delete failed: <err>`，**exit 1**（local cleanup 失敗；token 可能仍可用）。此時 sentinel 仍存在，要 `os.Remove(.uninstalling)` 還原避免 daemon 永久卡死

6. **檔案清理（ordered explicit delete，不用 RemoveAll）**：必須以特定順序逐項刪除，optional artifacts 對 ErrNotExist 寬容，**`config.toml` 倒數第二刪、`.uninstalling` 一定最後刪**：

   ```
   a. os.Remove(~/.caliber-agent/state.json)           # optional — ErrNotExist OK
   b. os.Remove(~/.caliber-agent/redaction-set.json)   # optional
   c. os.Remove(~/.caliber-agent/agent.log)            # optional — enroll+immediate-uninstall 場景沒這檔
   d. os.Remove(~/.caliber-agent/paused)               # optional
   e. os.Remove(~/.caliber-agent/.lock)                # optional
   f. os.Remove(~/.caliber-agent/config.toml)          # 必須存在（pre-flight 已驗）；倒數第二刪
   g. os.Remove(~/.caliber-agent/.uninstalling)        # 最後刪 sentinel；必須存在（step 3 剛寫）
   h. os.Remove(~/.caliber-agent/)                     # rmdir empty
   ```

   **錯誤處理**：
   - (a)-(e) optional steps：`errors.Is(err, fs.ErrNotExist)` → 忽略繼續；其他錯誤 → 印 `[error]` + sentinel 還原 + exit 1
   - (f) config.toml：pre-flight 已驗存在，這裡 IO 失敗 → 印 `[error]` + sentinel 還原 + exit 1
   - (g) sentinel：剛寫的應該存在，失敗 → 印 `[error]` + exit 1（不還原 — 自己刪不掉就重寫沒意義）
   - (h) rmdir：sentinel 已刪不重寫；失敗印 `[error] rmdir failed: <err>; manually 'rmdir ~/.caliber-agent/' to finish` exit 1

   為什麼**不**用 `os.RemoveAll`：`RemoveAll` 內部用 `Readdir` 列出 entries 然後逐個刪，**Readdir 順序由 file system 決定、不可預期**。如果 `.uninstalling` 先被刪、`config.toml` 還在，並發 `caliber-agent run` 的 pre-flight 會：
   - Stat dir → OK
   - Stat `.uninstalling` → `ErrNotExist` → **過**（不知道 uninstall 還在進行）
   - Stat `config.toml` → OK
   - 進到 step 2 OpenFile `.lock` → **違反「uninstall 後該目錄不留檔」契約**

   為什麼 config.toml 倒數第二（**不**第一）：retry 友善 — 若 cleanup 中途失敗於 step (a)-(e) 且 sentinel 還原成功，user 重跑 `uninstall` 時 config.toml 仍存在，pre-flight 通過、重走 cleanup；如果 config.toml 在 step a 就刪，重跑會撞 ErrNotEnrolled 早期退出，user 無法繼續完成 cleanup。

   **retry 適用範圍（重要邊界）**：

   | 失敗點 | 可重跑 `uninstall`？ | 補救 |
   |---|---|---|
   | (a)-(e) 任一 step 出現非 ErrNotExist 錯誤 | ✓ | 還原 sentinel + exit 1 → user 重跑 `uninstall`，pre-flight 看到 config.toml + 寫新 sentinel + 從頭走 cleanup |
   | (f) config.toml 刪除失敗 | ✓ | 還原 sentinel + exit 1 → 同上 |
   | (f) 成功之後、(g) 之前 SIGINT / crash | ✗ | config.toml 已不在、sentinel 還在 → 重跑撞 pre-flight 第三條 ErrNotEnrolled → 須手動 `rm -rf ~/.caliber-agent/` 並到 web UI revoke device（見 §8.2） |
   | (g) sentinel 刪除失敗 | ✗ | sentinel 已刪不重寫；其他檔已不在 → 須手動 rmdir |
   | (h) rmdir 失敗 | ✗ | 空 dir 殘留 → 印錯誤訊息要 user 手動 `rmdir ~/.caliber-agent/` |

   retry-friendliness 涵蓋的是「handled errors during cleanup steps (a)-(f)」，**不**涵蓋 (f) 之後的中斷。中斷後續手動補救流程已於 §8.2 列出。

   ordered delete 保證的不變條件（任何時刻 `.uninstalling` 與 `config.toml` 的狀態組合）：
   - (a)-(e) 期間：sentinel 在、config 在 → 並發 run/pause 看到 sentinel 立即退出
   - (f) 完成 (sentinel 在、config 不在)：並發 run/pause 看到 sentinel 退出 OR config missing 退出（兩條防線同時生效）
   - (g) 完成 (sentinel 不在、config 不在)：並發 run/pause 看到 config missing 退出
   - (h) 完成 (dir 不在)：並發 run/pause 看到 dir not exist 退出

   **永遠不會發生「sentinel 不在、config 在」的狀態** — 這是設計核心 invariant。

7. **印最終清單**（合規守則要求 — anti-forensics 反向：透明可審）：

   ```
   Removed:
     ✓ remote device d_HxKp... (server: revoked at 2026-05-25T...)
     ✓ keychain entry tw.caliber.agent / d_HxKp...
     ✓ ~/.caliber-agent/ (6 files, 12 KiB)
   ```

   若 step 4 失敗：

   ```
   Partial:
     ✗ remote (failed: <reason>; revoke manually at <api_base_url>/dashboard/devices)
     ✓ keychain entry tw.caliber.agent / d_HxKp...
     ✓ ~/.caliber-agent/ (6 files, 12 KiB)
   ```

退出碼：
- 0 — 全部清理（含遠端 best-effort 失敗，但 keychain + fs 成功）
- 1 — **本地清理任一步失敗**（包含 daemon 仍在跑且無 `--force` / keychain delete 非 ErrNotFound 失敗 / ordered delete 任一 step 失敗）；step 3 之後失敗必須 `os.Remove(.uninstalling)` 還原避免 daemon 永久卡死（但 sentinel 已刪 + rmdir 失敗的特殊 case 例外，見 step 6）
- 130 — user cancel 或 non-TTY without `--yes`；**因 sentinel 尚未寫入，無須還原**（這是新設計與 round 3 的主要差別 — sentinel 寫入移到 prompt 後）

### 3.7 `caliber-agent run` 行為微調（為支援 F2 lockfile + sentinel）

`run` 啟動序列加入**五個**新動作（不改變 user-visible CLI）：

1. **Pre-flight read-only checks（任何寫入動作之前完成）**：
   依序 stat，命中失敗即 exit，**不建立任何檔案、不執行任何 write syscall**：
   - `os.Stat(~/.caliber-agent/)` → 套用 §3.7 step 3 表格的 dir presence 規則：`ErrNotExist` → `[fatal] not enrolled (config directory missing); run 'caliber-agent enroll <token>' first` exit 1
   - `os.Stat(~/.caliber-agent/.uninstalling)` → 套用 sentinel 規則（fail-closed）：存在或 stat 非 ErrNotExist 錯誤 → `[fatal] uninstall in progress (or stat failed); aborting startup` exit 0
   - `os.Stat(~/.caliber-agent/config.toml)` → 套用 presence 規則：`ErrNotExist` → `[fatal] not enrolled (config.toml missing — partial cleanup?); re-enroll or remove ~/.caliber-agent/` exit 1
   - 這三條都不寫入。場景覆蓋：
     - 未 enroll：`dir not exist` → exit 1
     - uninstall 進行中（任何階段，含 ordered delete (a)-(f) 期間）：`.uninstalling` 仍在 → exit 0
     - stale empty config dir（user 手動 mkdir）：`config.toml missing` → exit 1（不會建 `.lock`）

2. **取得 lockfile + 寫 PID**：
   - `os.OpenFile(~/.caliber-agent/.lock, O_RDWR|O_CREATE, 0o600)` — **不帶 O_TRUNC**，**不帶 MkdirAll**（dir 已在 step 1 驗證存在）
   - `syscall.Flock(fd, LOCK_EX|LOCK_NB)`。失敗 → 印 `another caliber-agent run is already active` exit 1（**flock 失敗後立即 close，不動檔案內容；既有 daemon 的 PID 保持完整**）
   - 成功取得 flock 後再執行：`fd.Truncate(0)` → `fd.Seek(0, 0)` → `fmt.Fprintf(fd, "%d\n", os.Getpid())`
   - **持有 fd 到 process exit**
   - **race 防護**：移除 `O_TRUNC` 是必要的 — 否則 second daemon open 時就 truncate，會在自己 flock 失敗前先擦掉既有 daemon 的 PID，違反「`.lock` 內容應為持有者 PID」契約

3. **Post-lock sentinel re-check（acquire lock 後立即，所有後續啟動動作之前）**：

   為什麼 step 1 已 stat 過 sentinel 還要再做一次？因為 pre-flight stat 與 step 2 OpenFile + Flock 之間有時間窗口 — uninstall 可能在那個窗口寫入 sentinel。Acquire lock 是 atomic single-writer point，是「我可以信任接下來看到的世界」的唯一時刻。


   - `os.Stat(~/.caliber-agent/.uninstalling)` 存在 → 立即（**不開 agent.log，不寫任何訊息進 fs**）返回 `&ExitError{Code: 0, Err: errors.New("[fatal] uninstall in progress; aborting startup")}`；Cobra 對該 `ExitError.Error()` 自動印到 stderr（`SilenceErrors=false`），不要手動 Fprintln 避免雙印。lockfd 在 `runRun` defer close 時釋放
   - **必須早於下列所有動作**（**not just network**）：
     - `config.Load()`（read-only，但確認意圖）
     - `LoadState()`（read-only）
     - `OpenAgentLog()`（**會建立或 append `agent.log`**）
     - `keychain.Get()`（會跨 process 呼叫 `/usr/bin/security`）
     - `BootstrapRedactionSet()`（會發 HTTP）
   - **唯一可接受的先行動作**是 step 1 的 `os.Stat(~/.caliber-agent/)` 檢查 + `.lock` 開檔（**不 MkdirAll**） + flock + 寫 PID。理由：lockfile 是「正確處理 sentinel 的前置條件」（要先持有 lock 才能保證 single-writer 對 `.uninstalling` 判讀）。`.lock` 本身的存在不算 anti-forensics 違規 — 它本來就是 lifecycle artifact；且只有在 config dir 已存在時才會建立，不會引入「未 enroll 跑 run 殘留檔」或「uninstall 中重建目錄」問題。
   - 退出時必須 close lockfd 釋放 flock 給其他 process（不留 stale flock）

   實作層級的具體要求：

   ```go
   // agent/internal/cli/run.go (revised order)
   func runRun(cmd *cobra.Command, once bool, interval time.Duration) error {
       // STEP 1: Pre-flight read-only checks (no MkdirAll, no OpenFile write)
       if err := preflightChecks(); err != nil {
           // dir missing / sentinel present / config.toml missing
           return err
       }

       // STEP 2: lockfile + PID
       //   acquireRunLock = OpenFile(.lock, O_RDWR|O_CREATE, 0o600)
       //                    + Flock(LOCK_EX|LOCK_NB)
       //                    + Truncate(0) + Seek(0,0) + WritePID
       //   *不* MkdirAll — STEP 1 已驗證 dir 存在
       lockFd, err := acquireRunLock()
       if err != nil { return err }
       defer lockFd.Close()

       // STEP 3: Post-lock sentinel re-check (catches pre-flight → acquire 窗口)
       // Fail-closed: stat error 非 ErrNotExist 一律當作 "sentinel 存在" 處理。
       _, statErr := os.Stat(config.UninstallSentinelPath())
       sentinelPresent := statErr == nil || !errors.Is(statErr, fs.ErrNotExist)
       if sentinelPresent {
           // 注意：root.go 設 SilenceErrors=false，Cobra 會自動印 err.Error() 到 stderr，
           // 所以這裡 *不* 額外 Fprintln 避免雙印；訊息直接放進 ExitError.Err。
           // 也不能傳 nil：既有 exit.go:19 `ExitError.Error()` 會 deref Err。
           msg := "[fatal] uninstall in progress; aborting startup"
           if statErr != nil {
               msg = fmt.Sprintf("[fatal] cannot stat uninstall sentinel (%v); failing closed", statErr)
           }
           return &ExitError{Code: 0, Err: errors.New(msg)}
       }

       // STEP 4+: existing config.Load / keychain.Get / BootstrapRedactionSet / loop
       cfg, err := config.Load()
       ...
   }
   ```

4. **Tick 開頭 + 每 SendChunk 前 stop-condition check**：

   三個 path 的 stat 規則（明確、互不矛盾）：

   | 檔案 | stat 回 `nil` | stat 回 `fs.ErrNotExist` | stat 回**其他**錯誤（EACCES/EIO 等） |
   |---|---|---|---|
   | `.uninstalling`（sentinel） | **stop**（exit 0） | continue | **stop**（fail-closed — 不能誤判 uninstall 沒在進行） |
   | `config.toml` | continue | **stop**（exit 0） | continue + `[warn] stat config: <err>`（retry-friendly — 暫時性磁碟故障不該誤殺 daemon） |
   | `.lock` | continue | **stop**（exit 0） | continue + `[warn] stat .lock: <err>` |

   檢查時機與順序：

   - **Tick 開頭**（順序：sentinel → paused → config → lock）
     1. `os.Stat(.uninstalling)` 套用上表第 1 行；命中 stop → `[fatal] uninstall in progress (or stat failed); aborting` exit 0
     2. 既有 paused sentinel 檢查（沿用 PR2 設計）
     3. `os.Stat(config.toml)` 套用上表第 2 行；ErrNotExist → `[fatal] config removed; daemon exiting` exit 0
     4. `os.Stat(.lock)` 套用上表第 3 行；ErrNotExist → `[fatal] lockfile removed; daemon exiting` exit 0

   - **Loop 內每個 `sink.SendChunk` 之前**（順序：sentinel → config；不檢 `.lock`，因為 lock fd 仍持有，flock 不會無故消失）
     1. `os.Stat(.uninstalling)` 套用上表第 1 行；命中 stop → `[fatal] uninstall in progress (or stat failed); aborting remaining chunks` exit 0
     2. `os.Stat(config.toml)` 套用上表第 2 行；ErrNotExist → `[fatal] config removed mid-tick; aborting remaining chunks` exit 0

   設計理由（為什麼三條規則不一樣）：

   - sentinel 是 **stop signal**：誤判成「沒在 uninstall」會繼續上傳 → 必須 fail-closed
   - config.toml / `.lock` 是 **presence signal**：唯一明確的「被刪了」是 ErrNotExist；其他錯誤是 stat 自己壞了不是檔案被刪，**錯殺 daemon** 比繼續跑代價更高（user 必須手動重啟 + 可能漏資料）

   這把 race 縮到「sentinel stat 與單個 SendChunk 之間 in-flight 的 1 chunk」。

5. **graceful exit**：context cancel / SIGTERM 時 close fd 釋放 lock。flock 在 process 死亡時 kernel 自動釋放，崩潰不留 stale lock。

這把 race condition 根除為**最小**窗口：

| 視窗 | 大小 | 後果 |
|---|---|---|
| `uninstall` 默認阻擋 running daemon | — | 0 chunk 上傳 |
| user 讀 prompt 期間（sentinel 尚未寫） | ≤ 數十秒（user 思考時間） | 既有 daemon 上傳延續其原行為（**非** uninstall 引入） |
| `uninstall` step 3 寫 sentinel → daemon 下次 per-chunk stat | 1 stat→SendChunk gap | 最多 1 個 in-flight chunk 送出 |
| sentinel 寫入後到 daemon 完全 exit | ≤ 1 chunk send latency | HTTP request 已 in-flight 的話 server 仍會收 |
| `uninstall` cleanup (a)-(e) 期間 user 另開 terminal 跑 `run` | 0 | sentinel + config 都在 → run pre-flight 看到 `.uninstalling` 立即 exit 0；不建 `.lock`、無任何 IO |
| `uninstall` cleanup (f)-(g) 之間（config 剛刪、sentinel 還在） | 0 | sentinel 仍在 → pre-flight `.uninstalling` 條目擋下；config missing 條目也會擋（雙保險） |
| `uninstall` cleanup (g)-(h) 之間（sentinel 也剛刪、dir 空） | 0 | sentinel 已不在但 config.toml 也已不在 → pre-flight `config.toml ErrNotExist` exit 1；不建 `.lock` |
| `uninstall` cleanup 完成後 user 跑 `run` | 0 | dir 不存在 → pre-flight 立即 exit 1 not enrolled |

### 3.8 `caliber-agent enroll <token>` 新 flag

新增 `--insecure` flag。預設拒絕 http:// scheme；`--insecure` 後允許並把 `insecure_transport = true` 寫進 config.toml。詳見 §6.2。

## 4. File State Changes

### 4.1 新增的本地檔

| 路徑 | Perm | 內容 | 寫入方 | 刪除方 |
|---|---|---|---|---|
| `~/.caliber-agent/paused` | 0o600 | 空檔（存在性 = 訊號） | `pause` | `resume` / `uninstall` |
| `~/.caliber-agent/.lock` | 0o600 | 寫入 PID（換行終止） + `flock` 持有 | `run` 啟動（fd held during lifetime） | `uninstall` step 6 ordered delete；process 死亡時 kernel 自動釋放 flock |
| `~/.caliber-agent/.uninstalling` | 0o600 | 空檔（存在性 = 訊號） | `uninstall` step 3（**user 確認 yes 之後**，所有路徑包含 `--force`） | `uninstall` step 6 ordered delete；step 5 或 6 失敗時 uninstall 手動 `os.Remove` 還原（避免 daemon 永久卡死）。**user cancel 時無須還原**（sentinel 尚未寫入） |

其餘 PR1/PR2/PR3 既有檔不變：`config.toml`、`state.json`、`redaction-set.json`、`agent.log`。

### 4.2 `config.toml` schema 變更

既有：

```toml
device_id     = "d_..."
hostname      = "..."
os            = "darwin arm64"
api_base_url  = "https://..."
mode          = "metadata-only"
include_paths = ["/Users/h/work/foo", "/Users/h/work/bar"]
```

PR4 新增 1 個欄位：

```toml
insecure_transport = false   # 預設 false；僅 enroll --insecure 時設為 true
```

`include_paths` 寫入規則收緊：

| 規則 | 適用時機 |
|---|---|
| 必須是絕對路徑 | enroll wizard、`add-path` |
| 寫入前 `filepath.EvalSymlinks` + `filepath.Clean` 正規化 | enroll wizard、`add-path` |
| 寫入後驗 `os.Lstat` 是目錄（非 symlink、非檔案） | enroll wizard、`add-path` |
| `api_base_url` 必須 `https://` scheme，除非 `--insecure` 在 enroll 時被使用 | enroll wizard、config.Load 啟動驗證 |

### 4.3 既有 config.toml 的相容性處理

PR1/PR2/PR3 既存 `config.toml` 若：

- 包含未正規化的 `include_paths`：**不 retro-normalise**。PR4 啟動的 `caliber-agent run` 在 tick 比對時若新 EvalSymlinks 後的 cwd 對不上舊字串，自然不 match。User 走 `remove-path` 舊條目 + `add-path` 新條目遷移。
- 缺少 `insecure_transport` 欄位：`config.Load` decode 出來時為 zero value `false`，等同「安全模式」預設。
- 包含 http:// `api_base_url` 但 `insecure_transport = false`（這是 PR4 之前不可能、PR4 之後 user 手動編輯才出現的不一致狀態）：`config.Load` 回 error `inconsistent config: http:// api_base_url with insecure_transport=false` exit 1。

理由：避免 silent 改寫使用者既有設定；遷移路徑顯式 + 文件化在 CHANGELOG。

### 4.4 `~/.caliber-agent/` 內容圖（PR4 完成後）

```
~/.caliber-agent/          # 0o700
├── config.toml            # 0o600  enroll/add-path/remove-path 寫
├── state.json             # 0o600  watcher tick 寫
├── redaction-set.json     # 0o600  redaction-set fetch / cache 寫
├── agent.log              # 0o600  daemon 追加
├── paused                 # 0o600  pause/resume 寫（可能不存在）
├── .lock                  # 0o600  run 啟動 flock 持有（可能不存在）
└── .uninstalling          # 0o600  uninstall 進行中 sentinel（可能不存在）
```

`uninstall` 後該目錄 + keychain entry 不留任何檔案。

### 4.5 state.json 跨 pause/resume 行為

pause 期間 watcher 不上傳，但 `state.Files[ref.Path].Offset` 仍維持上次成功 sync 的位置。resume 後從該位置接續 — 即 pause 期間檔案新增的 bytes 在 resume 後一次跑完。

邊界：

- pause 期間檔案被 rotate / 刪除：下個 tick `[warn] file gone`，state 條目保留待 tick 自然處理（既有 PR2 行為）。
- pause 期間檔案 shrink：既有 PR2 `ErrFileShrank` 處理：offset 重置為 0 並重讀。

pause 不引入新的 state 衝突 risk。

## 5. Server-side `DELETE /v1/devices/me`

### 5.1 Endpoint

```
DELETE /v1/devices/me
Authorization: Bearer cda_*
```

無 request body。

### 5.2 Auth pipeline（PR3 helper + 新增 allow-revoked 變體）

**重要**：PR3 既有的 `resolveDeviceFromAuth` 在 `device.revokedAt != null` 時直接回 401 `device_revoked`（`apps/api/src/rest/ingestAuth.ts:63`）。**且 revoke endpoint 的 UPDATE 同時把 `status` 設成 `'revoked'`**，所以即使 helper 跳過 `deviceRevokedAt` 檢查、`status !== "active"` 那條仍會把第二次 DELETE 擋成 401 `device_inactive` — 410 分支仍不可達。

修法：新增 `resolveDeviceFromAuthAllowRevoked` 變體，**deviceRevokedAt 非 null 時 short-circuit return ok**（在 status 檢查之前），由 caller 判斷該回 204 還是 410。`device_inactive`（非 revoked 的 frozen / 其他狀態）仍是 401。

```ts
// apps/api/src/rest/ingestAuth.ts (extend; ingest 路徑不變)
export interface ResolvedDeviceWithStatus extends ResolvedDevice {
  alreadyRevoked: boolean;
}

export async function resolveDeviceFromAuthAllowRevoked(
  db: Database,
  env: ServerEnv,
  authHeader: string | undefined,
): Promise<
  | { ok: true; device: ResolvedDeviceWithStatus }
  | { ok: false; error: Exclude<AuthFailure, "device_revoked"> }
> {
  // ... 前段同 resolveDeviceFromAuth（pepper check / Bearer / cda_ prefix / row lookup / keyRevokedAt）...
  if (!row) return { ok: false, error: "invalid_token" };
  if (row.keyRevokedAt !== null) return { ok: false, error: "key_revoked" };

  // KEY DIFFERENCE: deviceRevokedAt 非 null 時 short-circuit return ok。
  // 這條 MUST 早於 status check — 否則 revoke SQL 同時把 status 設成 'revoked'，
  // 第二次 DELETE 會被 status !== 'active' 擋成 device_inactive。
  if (row.deviceRevokedAt !== null) {
    return {
      ok: true,
      device: {
        deviceId: row.deviceId,
        userId: row.userId,
        orgId: row.orgId,
        alreadyRevoked: true,
      },
    };
  }

  // 未 revoked 但 status 非 active（例如管理員 freeze）→ 拒絕，避免「frozen 後仍可自殺撤銷」。
  if (row.status !== "active") return { ok: false, error: "device_inactive" };

  return {
    ok: true,
    device: {
      deviceId: row.deviceId,
      userId: row.userId,
      orgId: row.orgId,
      alreadyRevoked: false,
    },
  };
}
```

```ts
// apps/api/src/rest/devicesRevokeSelf.ts (new)
import type { FastifyPluginAsync } from "fastify";
import type { ServerEnv } from "@caliber/config";
import { resolveDeviceFromAuthAllowRevoked } from "./ingestAuth.js";
import { writeAudit } from "../services/audit.js";

export function devicesRevokeSelfRoutes(env: ServerEnv): FastifyPluginAsync {
  return async (fastify) => {
    fastify.delete("/v1/devices/me", async (req, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }

      const auth = await resolveDeviceFromAuthAllowRevoked(
        fastify.db, env, req.headers.authorization,
      );
      if (!auth.ok) {
        if (auth.error === "server_misconfigured") {
          reply.code(500);
          return { error: "internal" };           // 500 not 401（見 F3 fix）
        }
        reply.code(401);
        return { error: auth.error };
        // 401 set: missing_token | invalid_token | key_revoked | device_inactive
        // 注意：device_revoked 不在此 endpoint 的 401 set；alreadyRevoked → 410
      }
      if (auth.device.alreadyRevoked) {
        reply.code(410);
        return { error: "device_already_revoked" };
      }
      // ... see §5.3 ...
    });
  };
}

// server.ts 註冊（mirrors devicesEnrollRoutes / ingestRoutes pattern）：
//   await app.register(devicesRevokeSelfRoutes(env));
```

`POST /v1/ingest` 與 `GET /v1/redaction-set` 仍用既有 `resolveDeviceFromAuth`，**未改動**。

### 5.3 DB transaction

```sql
UPDATE devices
SET status = 'revoked', revoked_at = NOW()
WHERE id = $deviceId AND revoked_at IS NULL
RETURNING id;
```

- `rowCount = 1`：軟撤銷成功 → 204
- `rowCount = 0`：device 已 revoked（與 PR3 ingest 認證流程的 `device_revoked` 路徑一致）→ 410

同 transaction 透過既有 `writeAudit` helper 寫 audit log（schema 用 `targetType`/`targetId`，**不是** `resourceType`/`resourceId`）：

```ts
await writeAudit(tx, {
  actorUserId: auth.device.userId,        // 注意：ResolvedDevice 欄位在 device 物件下
  action: "device.self_revoked",          // new action type
  targetType: "device",
  targetId: auth.device.deviceId,
  orgId: auth.device.orgId,
  metadata: {
    trigger: "agent_uninstall",
    user_agent: req.headers["user-agent"],
  },
});
```

**device.revokedAt 一旦設值，既有 PR3 ingest auth 路徑 (`ingestAuth.ts:63`) 會自動拒絕後續 cda_\* 請求**，所以 device-level revoke 已足夠 — 不需要額外撤銷 `device_api_keys` 行。

### 5.4 Response

| 狀態 | 回應 body | 場景 |
|---|---|---|
| 204 No Content | (empty) | 成功撤銷（第一次 DELETE） |
| 410 Gone | `{"error":"device_already_revoked"}` | device 已被撤銷（idempotent；daemon 視為等同成功） |
| 401 Unauthorized | `{"error":"missing_token" \| "invalid_token" \| "key_revoked" \| "device_inactive"}` | **不含 `device_revoked`** — 已撤銷走 410 而非 401 |
| 404 Not Found | `{"error":"not_found"}` | `ENABLE_GATEWAY=false`（mirrors enroll endpoint） |
| 500 Internal | `{"error":"internal"}` | DB 例外 **或** `server_misconfigured`（缺 `API_KEY_HASH_PEPPER` 等） |

注意 1：401 set 從 ingest endpoint 的 5 種降到 4 種；少一個 `device_revoked`。這是本 endpoint 唯一允許「device 已撤銷狀態下仍可呼叫」的設計差異。

注意 2：helper return type 包含 `server_misconfigured`，但 route 必須對它回 **500** 而不是 401（缺 pepper 是 ops 配置問題，不是 caller 認證問題）。

### 5.5 Daemon 端 `Client.RevokeSelf`

```go
// agent/internal/api/revoke.go (new)
func (c *Client) RevokeSelf(ctx context.Context, token string) error {
    req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
        c.BaseURL+"/v1/devices/me", nil)
    if err != nil {
        return fmt.Errorf("api: build revoke: %w", err)
    }
    req.Header.Set("Authorization", "Bearer "+token)
    req.Header.Set("User-Agent", c.UserAgent)

    resp, err := c.HTTP.Do(req)
    if err != nil {
        return fmt.Errorf("api: revoke http: %w", err)
    }
    defer resp.Body.Close()

    switch resp.StatusCode {
    case 204, 410:
        return nil                                    // idempotent success
    case 401:
        body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<14))
        return parseAuthError(resp.StatusCode, body)  // 既有 APIError + sentinel
    default:
        body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<14))
        return &APIError{StatusCode: resp.StatusCode, Body: string(body)}
    }
}
```

`uninstall` 流程任何 error 都不阻擋本地清理，但會印 `[warn]` 並列出原因。

## 6. 合規硬化各項細節

### 6.1 Symlink 防護（W1）

**策略**：watcher 將要讀取的 jsonl 路徑一律先 `os.Lstat` 過濾掉 symlink；IncludePaths 比對前的 cwd 一律先 `filepath.EvalSymlinks` 解析到真實路徑。IncludePaths 在 enroll / add-path 寫入時已正規化（§4.2）。

| 位置 | 改動 |
|---|---|
| `watcher/claude.go:List` | 列出 jsonl 時 `os.Lstat` 過濾 symlink；遇到印 `[warn] skipping symlink: <path>` |
| `watcher/codex.go:List` | 同上 |
| `watcher/codex.go:readCWD` | 開檔前 `os.Lstat`；symlink 則 return `""` |
| `cwdresolve.go:tryExtractCWD` | jsonl 解析出的 `cwd` 字串先 `EvalSymlinks` 再 `Stat`；解析失敗 / broken symlink 回 `""` |
| `cwdresolve.go:dirnameFallback` | greedy decode 結束後對結果 `EvalSymlinks` 再回傳 |
| `watcher/loop.go:allowed` | 比對前對 cwd 做 `EvalSymlinks`（best-effort：失敗則用原值） |

設計權衡：**watcher 一律拒絕 symlinked jsonl（最嚴格）**，但 **cwd 接受 symlink 解析後的真實路徑（彈性）**。理由：jsonl 是 Claude/Codex 寫入的，使用者沒理由 symlink；但使用者工作目錄可能透過 symlink 連到 `~/Code/foo` 是常見場景。

### 6.2 HTTPS 強制（W2）

```go
// agent/internal/config/config.go (new helper)
func ValidateAPIBaseURL(raw string, allowInsecure bool) error {
    u, err := url.Parse(raw)
    if err != nil || u.Scheme == "" || u.Host == "" {
        return fmt.Errorf("invalid api_base_url: %q", raw)
    }
    // 嚴格白名單：永遠允許 https；只有 --insecure 才額外允許 http。
    // 拒絕 ftp / file / gopher / 自訂 scheme 等任何非 http(s) 形式。
    if u.Scheme == "https" {
        return nil
    }
    if u.Scheme == "http" && allowInsecure {
        return nil
    }
    if u.Scheme == "http" {
        return fmt.Errorf("api_base_url uses http://; pass --insecure to allow (dev/local only)")
    }
    return fmt.Errorf("api_base_url must be https:// (got scheme %q)", u.Scheme)
}
```

驗證點：

| 時機 | 來源 | allowInsecure |
|---|---|---|
| enroll | flag `--api-base-url` 或 env `CALIBER_API_BASE_URL` | `--insecure` flag |
| `run` 啟動 | `cfg.APIBaseURL` 從 config.toml 載入 | `cfg.InsecureTransport`（enroll 寫入） |

`run` 啟動讀到 `insecure_transport = true` 時印 `[warn] insecure transport (http://) in use; device enrolled with --insecure`，繼續執行。

### 6.3 Regex 上限（W3）

```go
// agent/redact/regexes.go
const (
    MaxRegexSrcLen  = 1024  // 單個 pattern 的 RegexSrc bytes 上限
    MaxPatternCount = 100   // RedactionSet 內 patterns 數量上限
)

func (p *Pattern) Compile() error {
    if p.Regex != nil {
        return nil
    }
    if len(p.RegexSrc) > MaxRegexSrcLen {
        return fmt.Errorf("pattern %q: regex too long (%d > %d)",
            p.Name, len(p.RegexSrc), MaxRegexSrcLen)
    }
    re, err := regexp.Compile(p.RegexSrc)
    ...
}

// agent/redact/set.go
func (r *RedactionSet) Compile() error {
    if len(r.Patterns) > MaxPatternCount {
        return fmt.Errorf("redaction set too large: %d patterns > limit %d",
            len(r.Patterns), MaxPatternCount)
    }
    ...
}
```

上限選擇理由：

- `MaxRegexSrcLen = 1024`：bundled patterns 最長 ~45 chars；1024 給 per-org override 寬餘但堵掉垃圾
- `MaxPatternCount = 100`：bundled 11 個；8× 寬餘
- Server 64 KiB body cap 是外層保護；本層是內層保護

策略 — **兩種錯誤類型分離，且必須改既有 bootstrap + refresher**：

```go
// agent/redact/set.go (new sentinel)
var ErrTooManyPatterns = errors.New("redact: pattern count exceeded MaxPatternCount")

func (r *RedactionSet) Compile() error {
    if len(r.Patterns) > MaxPatternCount {
        // hard fail — 不要 compile 任何 pattern，避免 fail-open
        return fmt.Errorf("%w: got %d limit %d", ErrTooManyPatterns, len(r.Patterns), MaxPatternCount)
    }
    // ... existing per-pattern compile，個別 RegexSrc 過長或語法錯誤走 aggregate error ...
}
```

| 錯誤類型 | sentinel | caller 行為 |
|---|---|---|
| Count limit 超過 | `errors.Is(err, ErrTooManyPatterns)` | **set 不可用**：bootstrap fallback 至 stale cache → bundled default；refresher 保留現有 set 不取代 |
| 個別 pattern 過長 / 語法錯 | aggregate error（非 sentinel） | **set 可用，壞 pattern 跳過**：bootstrap/refresher `[warn]` 後 `Set(set)` |

**必須改既有程式碼**（這是 PR3 既有的 fail-open 源頭）：

```go
// agent/internal/cli/redactionset.go: BootstrapRedactionSet（既有 line 85-89 是 fail-open 源）
// before:
//     if err := set.Compile(); err != nil {
//         logger.Printf("[warn] %v", err)
//     }
//     prov.Set(set)                       // <-- 這行對 ErrTooManyPatterns 是 fail-open
//     _ = config.SaveRedactionSet(set)
// after:
if err := set.Compile(); err != nil {
    if errors.Is(err, redact.ErrTooManyPatterns) {
        logger.Printf("[error] fresh redaction-set rejected: %v; falling back", err)
        // 同 fetch 失敗的 stale/default fallback 路徑
        if hasCache {
            _ = cached.Compile()
            prov.Set(cached)
            return prov, nil
        }
        prov.Set(redact.DefaultSet())
        return prov, nil
    }
    logger.Printf("[warn] %v", err)        // per-pattern errors — set 仍可用
}
prov.Set(set)
_ = config.SaveRedactionSet(set)

// agent/internal/cli/run.go refresher goroutine 同樣處理：
// ErrTooManyPatterns → 保留現有 setProvider.Current()，不取代；log [error]
// 其他 Compile error → 既有 [warn] + Set(set) 行為不變
```

關鍵保證：**ErrTooManyPatterns 永遠不會讓 nil-Regex 的 set 取代既有 set**。若 daemon 啟動時 fresh fetch 撞 ErrTooManyPatterns 且無 cache，fallback 為 `redact.DefaultSet()`（bundled），絕不可能是 nil regex set。

Regression tests（必須）：

```
TestBootstrap_FreshFetchTooManyPatterns_FallsBackToStale
TestBootstrap_FreshFetchTooManyPatterns_NoCache_FallsBackToDefault
TestRefresher_FreshFetchTooManyPatterns_KeepsCurrent
TestRedactionSetCompile_TooManyPatterns_NoCompileMutation
  // 斷言 Compile() 回 ErrTooManyPatterns 後 Patterns[i].Regex 全部仍是 nil 且 set 未被外部 caller 使用
```

### 6.4 `--api-base-url` 限縮到 enroll only（W4）

```go
// agent/internal/cli/root.go
// 移除：
//   cmd.PersistentFlags().StringVar(&flags.APIBaseURL, "api-base-url", ...)
// PersistentFlags 只留 --config-dir + --verbose

// agent/internal/cli/enroll.go
func newEnrollCmd() *cobra.Command {
    var apiBaseURL string
    var insecure bool
    var force bool
    cmd := &cobra.Command{...}
    cmd.Flags().StringVar(&apiBaseURL, "api-base-url", "",
        "caliber API URL (or set CALIBER_API_BASE_URL)")
    cmd.Flags().BoolVar(&insecure, "insecure", false,
        "allow http:// in api-base-url (dev/local only)")
    cmd.Flags().BoolVar(&force, "force", false, "re-enroll over existing device")
    ...
}
```

### 6.5 `cli/run.go:29` 文案

```go
// before:
Short: "Run the daemon main loop (foreground; launchd-managed in production)",
// after:
Short: "Run the daemon main loop (foreground; you start and stop it manually)",
```

### 6.6 `set-mode` 從 root 移除（N3）

| 動作 | 檔案 |
|---|---|
| 刪除 | `agent/internal/cli/setmode.go` |
| 從 root.AddCommand 移除 | `agent/internal/cli/root.go:41` |
| 對應 stub 測試刪除 | `agent/internal/cli/stubs_test.go`（搜 `set-mode` 段移除） |
| help 輸出測試更新 | 驗證 `--help` 列表的測試 |

Mode 切換流程：使用者手動編輯 `config.toml` 後 `caliber-agent run` 重啟。PR3 OBS-2 的 startup mode allowlist 仍生效（無效 mode → exit 1）。

### 6.7 README env 變數文件化（N4）

`agent/README.md` 新增 "Environment variables" 章節：

| Env | 作用 | 讀取時機 |
|---|---|---|
| `CALIBER_AGENT_HOME` | 覆寫 `~/.caliber-agent` 根目錄 | 任何子命令啟動 |
| `CALIBER_API_BASE_URL` | enroll 時的 default API base URL | **僅 enroll**（`run` 從 config.toml 讀） |
| `CALIBER_CLAUDE_PROJECTS` | 覆寫 Claude transcript 根目錄 | enroll wizard scan / `run` 啟動 |
| `CALIBER_CODEX_SESSIONS` | 覆寫 Codex sessions 根目錄 | `run` 啟動 |

`CLAUDE_PROJECTS` / `CODEX_SESSIONS` 兩個既為 "undocumented test override"，PR4 正式文件化（標 advanced / dev use）。

### 6.8 consent banner（add-path）+ uninstall 印清單

已於 §3 規格化。

## 7. Data Flow

### 7.1 `add-path` happy path

```
user                CLI                       Disk
 |                   |                          |
 | add-path /A/B     |                          |
 |------------------>|                          |
 |                   | EvalSymlinks + Clean     |
 |                   | → /A/B-real              |
 |                   | Lstat → IsDir? yes       |
 |                   | Load config.toml         |
 |                   |<-------------------------|
 |                   | append IncludePaths      |
 |   prompt y/N      |                          |
 |<------------------|                          |
 | y                 |                          |
 |------------------>|                          |
 |                   | atomic write             |
 |                   |------------------------->|
 |   [ok] added /A/B |                          |
 |   restart hint    |                          |
 |<------------------|                          |
```

**`add-path` 對「正在跑的 daemon」不立即生效**：daemon 在 `runRun` 啟動時讀一次 cfg，後續 tick 不重讀。設計取捨：避免 tick 內每次 stat config.toml；SIGHUP reload 留給後續 PR（§12）。`add-path` stdout 明確提示 `restart 'caliber-agent run' to pick it up`.

### 7.2 pause 與正在跑的 daemon

```
T0  user 啟動 caliber-agent run（前景）
T1  daemon Tick #1 → 上傳 chunks
T2  ... sleep 60s ...
T3  另一 terminal: caliber-agent pause
       → touch ~/.caliber-agent/paused
T4  daemon Tick #2 開頭:
       stat ~/.caliber-agent/paused → 存在
       log "[paused] skipping tick"
       continue (不執行 source.List / tail / sink)
T5  ... sleep 60s ...
T6  daemon Tick #3 同 T4
T7  caliber-agent resume
       → rm ~/.caliber-agent/paused
T8  daemon Tick #4 stat → 不存在 → 正常執行
       上傳 pause 期間累積的 bytes
```

Tick 內檢查精確點：`Loop.Tick` 最開頭，在任何 `source.List` 之前。pause 不中斷已開始的 tick（粒度為 tick 而非 chunk）。

### 7.3 uninstall happy path（網路可達）

```
user      CLI            Server      Keychain    FS
 |         |                |             |       |
 | uninst  |                |             |       |
 |-------->|                |             |       |
 |         | probe .lock (no O_CREATE) → ErrNotExist or flock_NB ok
 |         |   ✓ no daemon                          |
 |         | prompt 顯示影響範圍               |       |
 | y       |                |             |       |
 |-------->|                |             |       |
 |         | write .uninstalling sentinel          |
 |         |---------------------------------------|------>|
 |         | DELETE /v1/devices/me                 |       |
 |         |--------------->|             |       |
 |         |    204         |             |       |
 |         |<---------------|             |       |
 |         | Delete(deviceID)             |       |
 |         |------------------------------>|       |
 |         |       ok                     |       |
 |         |<------------------------------|       |
 |         | ordered_delete: state/redaction-set/log/paused/.lock (optional, ErrNotExist OK) → config.toml → .uninstalling → rmdir
 |         |---------------------------------------|------>|
 |         |       ok                              |       |
 |         |<--------------------------------------|-------|
 | Removed:|                                       |       |
 |  ✓ ... |                                        |       |
 |<--------|                                       |       |
```

**完整順序：probe lock（no-create）→ prompt + 確認 → 寫 `.uninstalling` sentinel → 遠端 revoke → keychain delete → ordered delete（sentinel 最後）→ 印清單**。理由：

1. probe 不建立 `.lock`（無 O_CREATE）— user cancel 不留檔
2. prompt 在 sentinel 寫入之前 — user cancel 是真的 0 side effect（daemon 完全不受影響）
3. sentinel 在 cleanup 啟動前 — running daemon 立即看到並退出，後續 remote/keychain/fs 期間 daemon 不再上傳
4. 遠端先：用 keychain 內的 token 認證，必須在 keychain 刪除前完成
5. keychain 再刪：失去這把鑰匙後本機不能再呼叫 server
6. 最後刪檔：用 ordered delete（**不**用 `RemoveAll` — 順序不可預期會造成「sentinel 先刪、config 還在」的 race，見 §3.6 step 6）；optional artifacts (state / redaction-set / agent.log / paused / .lock) 先刪且 ErrNotExist 忽略 → `config.toml` 倒數第二刪 → `.uninstalling` 最後刪 → rmdir。設計 invariant：「sentinel 不在 & config 在」這個組合永遠不會發生

### 7.4 uninstall degraded paths

| 場景 | 行為 |
|---|---|
| daemon 仍在跑、無 `--force` | step 1 probe flock 失敗 → 拒絕 exit 1（未寫 sentinel） |
| daemon 仍在跑、`--force` | step 1 跳過拒絕邏輯；step 3 寫 `.uninstalling`；daemon 在下個 per-chunk check 自我退出（§3.7） |
| `.lock` 不存在（從未 run 過） | step 1 `ErrNotExist` 視為「無 daemon」直接過；**uninstall 永不建立空 `.lock`** |
| `--keep-remote` | 跳過 step 4；stdout `Skipped remote revoke (--keep-remote). Manually revoke at <api_base_url>/dashboard/devices.`；繼續 step 5 + 6 |
| 遠端 401 / network / 5xx | step 4 印 `[warn]`；繼續 step 5 + 6；最終清單把 remote 行改為 `✗ remote (failed: ...)`；退出碼 0 |
| keychain ErrNotFound | step 5 印 `[ok] keychain entry already absent`；繼續 step 6 |
| keychain 非 ErrNotFound 失敗 | step 5 印 `[error]`；`os.Remove(.uninstalling)` 還原；**exit 1**（token 可能仍可用） |
| ordered_delete (a)-(f) 失敗 | step 6 印 `[error]`；`os.Remove(.uninstalling)` **還原**（user 可重跑）；退出碼 1 |
| ordered_delete (g) sentinel 刪除失敗 | 其他檔已不在；sentinel **不還原**；退出碼 1 |
| ordered_delete (h) rmdir 失敗 | 空 dir 殘留；sentinel 已刪不還原；印 `manually 'rmdir ~/.caliber-agent/' to finish`；退出碼 1 |
| user 拒絕 confirm (`n`) | exit 130；**sentinel 尚未寫**，0 side effect；無還原動作 |
| non-TTY 無 `--yes` | 同上：early exit 130，0 side effect |
| 未 enroll 就 uninstall | `config.Load() == ErrNotEnrolled` → 早期 exit 1（未 probe、未寫 sentinel） |
| uninstall 中 user 另開 terminal 跑 `run` | §3.7 step 1 pre-flight 立即看到 `.uninstalling` 即 exit 0；若沒看到（pre-flight → acquire 之間 sentinel 才寫），step 3 post-lock re-check 攔下；任一情境都 0 network IO |

### 7.5 enrol → run → pause → resume → uninstall 完整生命週期

```
enroll <token> --api-base-url=https://...
  → writes config.toml + keychain + state.json(空)
run
  → reads config + keychain → 60s tick loop（foreground）
pause (另一 terminal)
  → touch paused
[daemon 下一 tick] → 空轉
resume
  → rm paused
[daemon 下一 tick] → 上傳累積的 bytes
Ctrl+C
  → daemon graceful exit 130
uninstall
  → DELETE /v1/devices/me → keychain.Delete → ordered_delete (optional artifacts first, config.toml second-to-last, .uninstalling last, rmdir)
```

## 8. Error Handling

### 8.1 Exit codes（既有 + PR4 變更）

PR1 既有：

| Code | 語意 |
|---|---|
| 0 | success |
| 1 | configuration error / IO error / fatal runtime |
| 64 | usage error（args 數量不符、無效 flag） |
| 70 | internal software error（recovered panic） |
| 130 | user interrupt (SIGINT / SIGTERM) |

PR4 不新增 code；每子命令的對應：

| 子命令 | 0 | 1 | 64 | 130 |
|---|---|---|---|---|
| `add-path` | 成功 / 已在 list | path 無效 / IO 失敗 | args 錯誤 | user 取消 / non-TTY 無 `--yes` |
| `remove-path` | 成功 / 不在 list | IO 失敗 | args 錯誤 | — |
| `pause` | 成功（含重複） | 未 enroll / uninstall 進行中 / 罕見 IO failure | — | — |
| `resume` | 成功（含未 pause） | IO 失敗 | — | — |
| `status` | 成功 | 未 enroll | — | — |
| `uninstall` | 全部清理（含遠端 best-effort 失敗，keychain + fs 全成功） | running daemon 拒絕 / keychain 非 ErrNotFound 失敗 / ordered delete 任一 step 失敗 | — | user 取消 / non-TTY 無 `--yes` |

### 8.2 邊界情境

`uninstall` step 名稱對應 §3.6：probe → prompt → sentinel → remote_revoke → keychain_delete → ordered_delete → listing.

| 情境 | 處理 |
|---|---|
| `pause` 期間 `run` 收到 SIGINT | graceful exit 130；sentinel 保留；下次 `run` 仍空轉直到 `resume` |
| 長期 paused 後 `run` | 正常空轉，每 60s 一行 `[paused] skipping tick`（log 噪音可接受） |
| `uninstall` `remote_revoke` 完成、`keychain_delete` **尚未呼叫** 時 SIGINT | exit 130；`.uninstalling` 殘留 → 重跑時 daemon 仍被擋；user 重跑 `uninstall`，第二次 `remote_revoke` 拿 410 idempotent → 繼續 `keychain_delete` + `ordered_delete` 完成 |
| `uninstall` `remote_revoke` + `keychain_delete` 完成、`ordered_delete` 之前 SIGINT | exit 130；keychain token 已不見，重跑 `caliber-agent uninstall` 走第二次 `remote_revoke` 會 401 invalid_token（無法 authenticate）。**正確補救**：重跑 `caliber-agent uninstall --keep-remote`（既然 remote 已 revoked），跳過 remote 直接 `keychain_delete`（拿 ErrNotFound → 視為已清）→ `ordered_delete` 完成 |
| `uninstall` `ordered_delete` 中 SIGINT | exit 130；部分檔案已刪除（含可能尚未刪的 `.uninstalling`、`config.toml`）。**重跑 `caliber-agent uninstall` 不可靠**：`config.Load() == ErrNotEnrolled` 早於 probe 退出（§3.6 開頭），無法定位 device_id 走 `keychain_delete`。**正確補救**：手動 `rm -rf ~/.caliber-agent/`（刪掉 `.uninstalling` 順便清掉 sentinel）+ 從 caliber web UI 手動 revoke device + 用 `security delete-generic-password -s tw.caliber.agent -a <device_id>` 清 keychain（若還記得 device_id）|
| `add-path` 對相對路徑 `./foo` | 拒絕 + `[error] add-path requires absolute path` exit 64 |
| `add-path` 對 broken symlink | `EvalSymlinks` 失敗 → `[error] cannot resolve path: <err>` exit 1 |
| `remove-path` 對 broken symlink | 跳過 `EvalSymlinks`、以 input 字串比對 IncludePaths；找到則移除 |
| `status` JSON 模式 IO 失敗 | stdout 印 `{"error":"..."}` exit 1（特殊輸出契約） |
| `add-path` / `uninstall` 在 non-TTY 環境無 `--yes` | 印 `non-interactive shell detected; pass --yes to confirm` exit 130 |

### 8.3 `uninstall` 部分失敗的退出碼語意

step 名稱同 §8.2。

| 場景 | 退出碼 | 理由 |
|---|---|---|
| 全部 cleanup steps 成功（`remote_revoke` + `keychain_delete` + `ordered_delete`） | 0 | 顯然 |
| `remote_revoke` 失敗、`keychain_delete` + `ordered_delete` 成功 | **0** | 本地 token + 檔案乾淨；user 看 stdout 警告知道要手動 revoke |
| `remote_revoke` 成功、`keychain_delete` ErrNotFound、`ordered_delete` 成功 | **0** | 罕見；視為已清；`ordered_delete` 仍乾淨 |
| `remote_revoke` 成功、`keychain_delete` 非 ErrNotFound 失敗 | **1** | token 仍可能在本機；`ordered_delete` 跳過；user 必須處理（避免 credential 被重用）；sentinel 還原 |
| `remote_revoke` + `keychain_delete` 成功、`ordered_delete` (a)-(f) 失敗 | 1 | 本地殘留檔案；sentinel **還原**（user 可重跑 uninstall） |
| `remote_revoke` + `keychain_delete` 成功、`ordered_delete` (g) sentinel 刪除失敗 | 1 | 其他檔已不在；sentinel **不還原**（重寫沒意義） |
| `remote_revoke` + `keychain_delete` 成功、`ordered_delete` (h) rmdir 失敗 | 1 | 空 dir 殘留；sentinel **已刪、不還原**；user 手動 `rmdir` |
| daemon 仍在跑且無 `--force`（`probe` 階段拒絕） | 1 | 早期拒絕；要 user 先停 daemon；**未寫 sentinel** |
| user 在 `prompt` 階段選 `n` | 130 | **未寫 sentinel**，0 side effect |
| 未 enroll 就跑 uninstall | 1 | `ErrNotEnrolled` 早於 `probe` 退出 |

**設計原則**：「本地清理成功 = uninstall 對 user 的承諾達成」**且 token 必須被消滅**。`keychain_delete` 是 token 消滅的唯一手段；非 ErrNotFound 失敗代表 token 可能仍可用，必須以 exit 1 警示 user。

### 8.4 API errors 對應

PR1 既有 sentinel：`api.ErrInvalidToken`、`api.ErrKeyRevoked`。

PR4 不新增 sentinel。`device_already_revoked` (410) 在 `Client.RevokeSelf` 內部 switch 視為 nil error 返回（idempotent success）；caller 不需區分。

### 8.5 Logger 一致性

所有子命令的 user-facing 輸出走 `cmd.OutOrStdout()` / `cmd.ErrOrStderr()`，不走 `agent.log`。`agent.log` 只給 `run` 的 daemon loop。`run` 期間的 `[paused]` log 行寫進 `agent.log`（既有 RFCLogger 路徑）。

## 9. Testing

### 9.1 Per-package coverage targets

沿用 PR3 的 80% gate（`agent/scripts/coverage.sh`）。新增 / 改動的 package：

| Package | 目標 | 重點 |
|---|---|---|
| `agent/internal/cli` | 85% | 6 個子命令 + flag wiring + 互動 prompt mock |
| `agent/internal/config` | 85% | `ValidateAPIBaseURL`、`InsecureTransport` 欄位 read/write、舊 config 相容 |
| `agent/internal/wizard` | 85% | enroll wizard 的 IncludePaths normalisation + `--insecure` 旁支 |
| `agent/watcher` | 85% | symlink rejection / pause sentinel / IncludePaths EvalSymlinks 比對 |
| `agent/internal/cwdresolve` | 85% | `tryExtractCWD` symlink、`dirnameFallback` EvalSymlinks |
| `agent/redact` | 85% | `MaxRegexSrcLen` / `MaxPatternCount` 邊界 |
| `agent/internal/api` | 85% | `RevokeSelf` 204 / 410 / 401 / 5xx / network 路徑 |
| `agent/internal/keychain` | 既有 100% | `Delete` ErrNotFound 路徑既存 |
| `apps/api` (server) | 沿用 repo 既有 | `devicesRevokeSelf.test.ts` 7 cases |

### 9.2 Key tests

#### CLI 層

```
TestAddPath_HappyPath_Atomic
TestAddPath_NotAbsolute_Exit64
TestAddPath_NonExistent_Exit1
TestAddPath_AlreadyInList_NoOp
TestAddPath_SymlinkInput_NormalisedToReal
TestAddPath_ConsentDeclined_Exit130
TestAddPath_YesFlag_SkipsPrompt
TestAddPath_NonTTY_NoYes_Exit130

TestRemovePath_HappyPath
TestRemovePath_NotInList_NoOp
TestRemovePath_BrokenSymlink_StillRemoves
TestRemovePath_NormalisesBeforeMatch

TestPause_TouchesSentinel
TestPause_Idempotent
TestPause_NoConfigDir_Exit1                            # R8-F1: 未 enroll 不建目錄
TestPause_ConfigTomlMissing_Exit1_NoPausedFileCreated  # R9-F1: stale empty dir 不建 paused
TestPause_UninstallInProgress_Exit1_NoPausedFileCreated # R9-F1: uninstall 期間拒絕寫 paused
TestResume_RemovesSentinel
TestResume_NotPaused_NoOp

TestStatus_HappyPath_Human
TestStatus_JSON_StructuredOutput
TestStatus_NotEnrolled_Exit1
TestStatus_Paused_ReflectedInOutput

TestUninstall_HappyPath_AllSteps_SentinelWrittenAfterPromptThenRemoved   # R4-F3
TestUninstall_OrderedCleanup_SentinelDeletedLast                          # R10-F1: 斷言 .uninstalling 是 dir 內最後一個被刪的檔
TestUninstall_OrderedCleanup_ConfigTomlDeletedBeforeSentinel              # R10-F1: 斷言刪除順序 config.toml < sentinel
TestUninstall_OrderedCleanup_RmdirFailsAfterSentinelRemoved_NoSentinelRestore  # R10-F1: rmdir 失敗時不重寫 sentinel
TestUninstall_YesFlag_SkipsPrompt_SentinelWrittenImmediately
TestUninstall_KeepRemote_SkipsServer
TestUninstall_RemoteFails_LocalStillCleaned_Exit0
TestUninstall_KeychainNotFound_Continues_Exit0
TestUninstall_KeychainDeleteFails_Exit1_SentinelRestored      # R1-F4: token 殘留警示 + 還原 sentinel
TestUninstall_LocalCleanupFails_Exit1_SentinelRestored        # R3: ordered delete 失敗時還原 sentinel
TestUninstall_DeclinedConfirm_Exit130_ZeroSideEffect          # R4-F3: 零 fs/network/keychain side effect
TestUninstall_NonTTY_NoYes_Exit130_ZeroSideEffect             # R4-F3: 同上
TestUninstall_RunningDaemon_Default_Exit1_NoSentinelWritten   # R3: 偵測階段就拒，不寫 sentinel
TestUninstall_RunningDaemon_Force_WritesSentinelAfterPrompt   # R3+R4: --force 不持 lock，sentinel 在 prompt 後
TestUninstall_LockProbe_NoOCreate_NoStaleLockFile             # R4-F2: probe 不留空 .lock
TestUninstall_LockProbe_ErrNotExist_TreatedAsNoDaemon         # R4-F2: ErrNotExist 視為「無 daemon」

TestRun_NoConfigDir_Exit1                               # R8-F1: 沒 ~/.caliber-agent/ 直接 not enrolled exit 1，不 MkdirAll
TestRun_DoesNotMkdirAllOnStartup                        # R8-F1: 斷言整個 startup 路徑 zero MkdirAll syscall
TestRun_PreflightSentinelExists_NoLockCreated           # R9-F1: pre-flight 看到 .uninstalling → 不 OpenFile .lock 不留檔
TestRun_PreflightConfigMissing_NoLockCreated            # R9-F1: dir 存在但 config.toml 缺 → 不 OpenFile .lock 不留檔
TestRun_PostLockSentinelAppearedMidStartup_Exit0        # R9-F1: pre-flight 通過、acquire 之後 sentinel 才寫 → step 3 攔下
TestUninstall_InvariantSentinelOutlivesConfigToml                 # R11-F3: 斷言 ordered_delete 從不留下「sentinel gone + config present」狀態（在 uninstall 側測 invariant，不是 run 側測異常狀態）
TestRun_AcquireLock_FailsIfAlreadyHeld_Exit1            # F2: 不允許 concurrent run
TestRun_AcquireLock_FailedFlock_DoesNotTruncatePID      # R7-F1: flock 失敗不擦既有 PID
TestRun_LockfileContainsPID                             # R2-F4: PID 寫入供 uninstall 顯示
TestRun_StartupSentinelCheck_BeforeKeychainAndFetch     # R4-F1: acquire lock 後 / network 動作前看到 .uninstalling 即 exit
TestRun_StartupSentinelCheck_NoNetworkIO                # R4-F1: 斷言整個 startup 路徑無 HTTP request 發出
TestRun_StartupSentinelCheck_StatEACCES_FailsClosed     # R7-F2 + R8-F2: stat 非 ErrNotExist 錯誤也 stop
TestRun_TickDetectsConfigRemoved_ExitsCleanly           # F2: tick 開頭自我退出
TestRun_TickDetectsUninstallSentinel_ExitsCleanly       # R3-F2: tick 開頭看到 .uninstalling 退出
TestRun_TickSentinelStatEACCES_FailsClosed              # R8-F2: tick 路徑 sentinel fail-closed
TestRun_TickConfigStatEACCES_DoesNotExit                # R8-F2: config stat 非 ErrNotExist 不退出（retry-friendly）
TestRun_PerChunkUninstallSentinel_AbortsRemainingChunks # R3-F2: 每 SendChunk 前先檢 sentinel（早於 config）
TestRun_PerChunkConfigCheck_AbortsRemainingChunks       # F5: config 缺失也退出（雙重保險）
```

#### watcher 層

```
TestTick_PausedSentinelExists_SkipsTick
TestTick_PausedSentinelRemovedMidPause_NextTickResumes
TestClaudeSource_List_SkipsSymlinkedJsonl
TestCodexSource_List_SkipsSymlinkedJsonl
TestCodexSource_ReadCWD_SymlinkReturnsEmpty
TestAllowed_EvalSymlinksOnCWD
TestCWDResolve_TryExtractCWD_SymlinkResolved
TestCWDResolve_DirnameFallback_EvalSymlinks
```

#### config 層

```
TestValidateAPIBaseURL_AcceptsHTTPS
TestValidateAPIBaseURL_RejectsHTTP_WithoutInsecure
TestValidateAPIBaseURL_AcceptsHTTP_WithInsecure
TestValidateAPIBaseURL_RejectsMalformed
TestConfig_InsecureTransport_RoundTrip
TestConfig_LoadOldFormat_DefaultsInsecureFalse
TestConfig_RejectsInconsistent_HTTPWithoutInsecure
```

#### redact 層

```
TestPatternCompile_RejectsOversized_KeepsOthers
TestRedactionSetCompile_RejectsTooManyPatterns_ErrSentinel        # F3: ErrTooManyPatterns 必出
TestRedactionSetCompile_TooManyPatterns_NoCompileMutation         # F3: 拒絕後 Regex 仍 nil；caller 必須走 fallback
TestRedactionSetCompile_AtBoundary                                # exactly MaxPatternCount = ok
TestBootstrap_FreshFetchTooManyPatterns_FallsBackToStale          # F3: bootstrap fallback 不接受 nil-regex set
TestBootstrap_FreshFetchTooManyPatterns_NoCache_FallsBackToDefault
TestRefresher_FreshFetchTooManyPatterns_KeepsCurrent              # F3: refresher 不取代
```

#### api 層

```
TestRevokeSelf_204_Success
TestRevokeSelf_410_Idempotent_NoError
TestRevokeSelf_401_InvalidToken
TestRevokeSelf_401_KeyRevoked
TestRevokeSelf_404_ReturnsAPIError                # R5-F4: ENABLE_GATEWAY=false; 不可當 idempotent / nil
TestRevokeSelf_500_ReturnsAPIError                # DB 例外 + server_misconfigured
TestRevokeSelf_NetworkError_Wrapped
```

### 9.3 Server-side 整合測試

`apps/api/tests/integration/rest/devicesRevokeSelf.test.ts`，10 cases：

1. happy path → 204 + DB row `revokedAt` 設值 + audit log `device.self_revoked` 寫入（透過 `writeAudit` helper，targetType/targetId 欄位）
2. 重複呼叫 → 第二次 410 device_already_revoked（**驗證 allow-revoked 變體不會回 401**）
3. invalid token → 401 invalid_token
4. revoked key → 401 key_revoked
5. **revoked device → 410 device_already_revoked**（**不是** 401；驗證 deviceRevokedAt short-circuit 早於 status check）
6. inactive device (status='frozen' 等非 revoked 的非 active) → 401 device_inactive
7. ak_* token（非 cda_*）→ 401 invalid_token
8. concurrent revoke（10× Promise.all）→ 1× 204 + 9× 410（與 #159 enrollment race 同 pattern）
9. **`ENABLE_GATEWAY=false` → 404 not_found**（F3 contract；mirror enroll endpoint）
10. **`API_KEY_HASH_PEPPER` 缺失 → 500 internal**（F3 contract；server_misconfigured 路徑 — 不是 401，避免把 ops 配置問題暴露成認證錯誤）

Regression：

```
ingest.test.ts:       POST after self-revoke → 401 device_revoked
devicesEnroll.test.ts: unchanged, run as regression
```

### 9.4 Privacy / 合規 regression tests

特別重要的反退化哨：

```
TestUninstall_DoesNotTouchHomeOutsideCaliberAgent
  // ordered delete 只動 ~/.caliber-agent/，斷言 ~/.claude 和 ~/.codex 未被觸碰

TestWatcher_NeverReadsOutsideClaudeAndCodexRoots
  // 已存在於 PR2，PR4 加入 symlink dimension

TestStatus_DoesNotMakeNetworkRequests
TestAddPath_DoesNotMakeNetworkRequests
TestRemovePath_DoesNotMakeNetworkRequests
TestPause_DoesNotMakeNetworkRequests
TestResume_DoesNotMakeNetworkRequests
  // 子命令對網路的 side-effect-free 保證
```

### 9.5 Local verify before push

```bash
cd agent
go vet ./...
$(go env GOPATH)/bin/staticcheck ./...     # CI 必跑，本地必跑（PR2/PR3 lesson）
gofmt -l .
go test ./... -race
./scripts/coverage.sh                       # ≥ 80% gate

cd ../apps/api
# Integration suite excludes itself from default `pnpm test` via vitest.config.ts:7;
# must use the dedicated integration config (mirrors `pnpm test:integration` script).
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/devicesRevokeSelf.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/devicesEnroll.test.ts   # regression
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/ingest.test.ts          # regression
pnpm -r build
```

### 9.6 CI

`agent-ci.yml` 與 server `lint-type-test` workflows 自動 pickup。本 PR 不新增 workflow 檔。

## 10. Public Contract (frozen at PR4)

PR4 merge 後這些介面凍結，未來 PR 只能擴充、不能 break。

### 10.1 Server REST

| Endpoint | Method | Auth | 凍結點 |
|---|---|---|---|
| `/v1/devices/me` | DELETE | Bearer cda_* | **204 / 410 / 401 / 404 / 500** 響應碼語意（404 = `ENABLE_GATEWAY=false`，mirror enroll；500 = DB 例外或 `server_misconfigured`） |

### 10.2 Agent CLI surface

| 子命令 | args / flags | 凍結點 |
|---|---|---|
| `add-path <path>` | flag `--yes` | consent banner 必印（除 `--yes`）；輸入正規化 EvalSymlinks + Clean |
| `remove-path <path>` | — | broken symlink 不阻擋移除 |
| `pause` | — | sentinel-based、idempotent |
| `resume` | — | 同上反向 |
| `status` | flag `--json` | **零網路呼叫**；human + JSON 兩種輸出 |
| `uninstall` | flags `--yes` `--keep-remote` `--force` | 偵測 running daemon 拒絕（除 `--force`）；完整順序：**probe lock (no-create) → prompt + 確認 → 寫 `.uninstalling` sentinel → remote revoke → keychain delete → ordered_delete（optional artifacts first, config.toml second-to-last, .uninstalling last, rmdir）→ 印清單**；keychain delete 非 ErrNotFound 失敗 → exit 1；user cancel 是真的 0 side effect；invariant：sentinel 不在時 config.toml 也一定不在 |
| `enroll` 新 flag | `--insecure` | 寫入 `insecure_transport = true` 進 config.toml |

### 10.3 Agent 既有 surface 變更

| 項目 | 變更 |
|---|---|
| `--api-base-url` PersistentFlag | **移除**（變 enroll 子命令 local flag） |
| `set-mode` 子命令 | **移除** |
| `run` 子命令的 `--once` / `--interval` | 不變 |
| Exit codes 0/1/64/70/130 | 不變 |

### 10.4 Filesystem artefacts

| Path | 凍結點 |
|---|---|
| `~/.caliber-agent/paused` | 存在 = paused；空檔；perm 0o600 |
| `~/.caliber-agent/.lock` | `run` 持有 flock；內容為 PID（換行終止）— 顯示用，**活性偵測一律用 `flock LOCK_NB` 探測，不是 stat 或讀 PID**（kernel 在 process 死亡釋放 flock，但檔案可能留下；PID 不能用 `kill -0` 探活，因為 PID 可能 reuse） |
| `~/.caliber-agent/.uninstalling` | 存在 = uninstall 進行中；空檔；perm 0o600；**user 確認 yes 後才寫**（cancel 不寫）；cleanup step 失敗時必須 `os.Remove` 還原；daemon 每 chunk 前檢查（早於 config 檢查），daemon `run` 啟動取得 lock 後也檢查（早於任何 network IO） |
| `~/.caliber-agent/config.toml` | 新增 `insecure_transport bool`（預設 false，缺失視為 false） |

### 10.5 Audit log action

| Action | Trigger |
|---|---|
| `device.self_revoked` | `DELETE /v1/devices/me` 成功時 |

### 10.6 Redaction 內部上限

| Constant | Value | 影響 |
|---|---|---|
| `MaxRegexSrcLen` | 1024 bytes | 單個 pattern 的 RegexSrc 上限 |
| `MaxPatternCount` | 100 | 整個 set 的 pattern 數量上限 |

Server side 不強制這些上限（保留彈性），但 per-org redaction set 管理 UI（Phase 4）需顯示 client 限制提示。

### 10.7 agent.log 新增 log 行 prefix

| Prefix | 觸發時機 |
|---|---|
| `[paused]` | tick 開頭發現 sentinel，跳過 tick |

既有 prefix（`[ingest]` / `[refresh]` / `[fatal]` / `[warn]` / `[error]` / `[debug]` / `[tick-end]`）不變。

## 11. Risks + Mitigations

| Risk | Mitigation |
|---|---|
| **R1.** `--insecure` 變成預設：使用者一次 enroll 用了 `--insecure` 後忘了，h4 stack 升級到 https 後 daemon 仍走 http | `run` 啟動每次印 `[warn] insecure transport`；`status` 輸出 `api_base_url: http://... (insecure)`；README 文件化 |
| **R2.** EvalSymlinks 在 macOS 上慢：每 tick 對每個 ref 做 stat + EvalSymlinks 累積開銷 | Loop 內 cwdCache 已存在（PR2）；PR4 擴展 cache 至 `(rawPath → realPath)`，每 path 一次 EvalSymlinks |
| **R3.** PR1 既有 config.toml 含未正規化路徑：升級到 PR4 後監看不到原本目錄 | 不 retro-normalise；user 透過 `remove-path` + `add-path` 遷移；README + CHANGELOG 提醒 |
| **R4.** `uninstall` 與 `run` 同時執行：terminal A 跑 daemon、terminal B 跑 uninstall。原 mitigation（依賴 SaveState 失敗自然退出）不成立 — `SaveState` 開頭就 `MkdirAll` 把目錄重建，loop 對 save 失敗只 log + 繼續，HTTPSink 持有記憶體裡的 token 仍能上傳 | **flock 探活 (no-create, no-acquire) + sentinel-after-prompt + 3-point check**（§3.6 + §3.7）：`run` 啟動取 `.lock` flock；`uninstall` 用 flock LOCK_NB **不帶 O_CREATE** 探活（cancel 不留空 `.lock`），拿不到默認拒絕、`--force` 不持 lock；**所有** uninstall 路徑於 step 3（user 確認 yes 之後）寫 `.uninstalling`；cleanup step 5/6 失敗時 `os.Remove` 還原；daemon 在三點檢查 sentinel：(a) `run` 啟動取得 lock 後 / 任何 network IO 前 (b) tick 開頭 (c) 每 SendChunk 之前。最大 race window：sentinel stat 與單個 SendChunk 之間 in-flight 的 1 chunk。**user cancel 是真的 0 side effect**（無 fs / network / keychain 變更） |
| **R5.** server `device.self_revoked` audit action 名稱與既有 `device.revoked` 重疊：admin 看不出差別 | 用不同 action type；audit log UI（Phase 4）顯示時兩者各有圖示。本 PR 只負責新增 action enum |
| **R6.** `--keep-remote` 變成劫持 backdoor：惡意腳本下 `uninstall --keep-remote` 後 server-side device 仍存活 | token 已在 keychain 被刪 → 本機無法重用；server-side device 不主動 revoke 是已知 trade-off（user 須到 web UI 處理）；stdout 強烈提示 |
| **R7.** `add-path` / `uninstall` 在 CI / 腳本下卡住 | `isatty(stdin) == false` 時不嘗試讀 stdin，直接印 `non-interactive shell detected; pass --yes to confirm` exit 130；`echo y \| caliber-agent ...` 也會被拒，明確要求腳本作者加 `--yes` |
| **R8.** pause 期間 transcript 巨量累積，resume 後爆量上傳 | PR2 既有 chunked gzip + 20 MiB/tick I/O cap 仍有效；多花幾個 tick 追上但不壓垮 server |
| **R9.** server `DELETE /v1/devices/me` 被當作攻擊面：取得 cda_* token 的攻擊者可主動撤銷該 device | token 已是高權限（可上傳 ingest），撤銷只是讓 device 不能再用，不放大攻擊；audit log 留痕 |

## 12. Out of Scope (with pointers to future PRs)

| 項目 | 何時做 |
|---|---|
| TLS certificate pinning | Phase 3 |
| `agent.log` rotation | Phase 3 |
| Cross-session batching (≤ 500 sessions/chunk) | Phase 3 |
| Per-org redaction set 編輯 UI（含 client 上限提示） | Phase 4 |
| GDPR purge heartbeat（server → daemon） | Phase 3 |
| Daemon metrics endpoint / dashboard | Phase 3 |
| Linux / Windows build target | Phase 5+ |
| SIGHUP config reload | 未排期 |
| `caliber-agent reload-config` 子命令 | 未排期 |
| launchd / systemd 自動啟動 | **永久排除**（Anthropic Usage Policy 對齊 policy decision） |

## 13. References

- Parent spec: `docs/superpowers/specs/2026-05-18-multi-source-ingest-design.md` §"MVP phasing" Phase 2
- PR1 spec: `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr1-design.md`
- PR2 spec: `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr2-design.md`
- PR3 spec: `docs/superpowers/specs/2026-05-23-caliber-agent-phase2-pr3-design.md` §10 (out-of-scope PR4 table — superseded by this spec)
- Compliance audit (in-conversation 2026-05-25): 13 PASS + 5 WARN + 4 NOTE items; PR4 必修清單衍生自此
- Server resolveDeviceFromAuth helper: `apps/api/src/rest/ingestAuth.ts` (PR3 extracted)
- Existing device revoke pattern (tRPC, session-auth): `apps/api/src/trpc/routers/devices.ts:106` (for reference; PR4 adds the REST + cda_* variant)
