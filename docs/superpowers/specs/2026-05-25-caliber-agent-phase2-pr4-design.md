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

1. **5 個子命令落地**: `add-path` / `remove-path` / `pause` / `resume` / `status` / `uninstall` 從 `ExitNotImplemented` 換成真實作。
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

行為：

1. `MkdirAll(~/.caliber-agent/, 0o700)` + `os.WriteFile(~/.caliber-agent/paused, []byte{}, 0o600)`.
2. 印 `paused. running daemon will skip ticks on next interval. resume with 'caliber-agent resume'.`

退出碼：0（idempotent — 重複 pause 不報錯）

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
```

行為：

1. **顯示影響範圍**：

   ```
   This will:
     1. Revoke this device at <api_base_url> (DELETE /v1/devices/me)
     2. Remove ~/.caliber-agent/ (config, state, redaction-set, agent.log)
     3. Remove keychain entry: tw.caliber.agent / <device_id>
   Continue? [y/N]
   ```

   `--yes` 跳過。非 TTY 場景見 §11 R7。

2. **遠端 revoke**（除非 `--keep-remote`）：best-effort
   - 204 / 410：印 `[ok] device revoked at server` / `[ok] device already revoked at server`
   - 401 / 403 / network / 5xx：印 `[warn] remote revoke failed: <reason>; continuing local cleanup` 並**繼續**

3. **keychain 清理**：`keychain.Delete(deviceID)`，`ErrNotFound` 視為已清；其他錯印 `[warn]` 繼續

4. **檔案清理**：`os.RemoveAll(~/.caliber-agent/)`

5. **印最終清單**（合規守則要求 — anti-forensics 反向：透明可審）：

   ```
   Removed:
     ✓ remote device d_HxKp... (server: revoked at 2026-05-25T...)
     ✓ keychain entry tw.caliber.agent / d_HxKp...
     ✓ ~/.caliber-agent/ (4 files, 12 KiB)
   ```

   若 step 1 失敗：

   ```
   Partial:
     ✗ remote (failed: <reason>; revoke manually at <api_base_url>/dashboard/devices)
     ✓ keychain entry tw.caliber.agent / d_HxKp...
     ✓ ~/.caliber-agent/ (4 files, 12 KiB)
   ```

退出碼：0 全部清理（含遠端 best-effort 失敗）/ 1 本地檔清理失敗 / 130 user cancel 或 non-TTY without `--yes`

### 3.7 `caliber-agent enroll <token>` 新 flag

新增 `--insecure` flag。預設拒絕 http:// scheme；`--insecure` 後允許並把 `insecure_transport = true` 寫進 config.toml。詳見 §6.2。

## 4. File State Changes

### 4.1 新增的本地檔

| 路徑 | Perm | 內容 | 寫入方 | 刪除方 |
|---|---|---|---|---|
| `~/.caliber-agent/paused` | 0o600 | 空檔（存在性 = 訊號） | `pause` | `resume` / `uninstall` |

唯一新增的本地檔。其餘 PR1/PR2/PR3 既有檔不變：`config.toml`、`state.json`、`redaction-set.json`、`agent.log`。

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
└── paused                 # 0o600  pause/resume 寫（可能不存在）
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

### 5.2 Auth pipeline（沿用 PR3 共用 helper）

```ts
// apps/api/src/rest/devicesRevokeSelf.ts (new)
import { resolveDeviceFromAuth } from "./ingestAuth";  // PR3 extracted

fastify.delete("/v1/devices/me", async (req, reply) => {
  const auth = await resolveDeviceFromAuth(req, fastify.db);
  if (!auth.ok) {
    return reply.code(401).send({ error: auth.error });
    // auth.error ∈ {"invalid_token", "key_revoked", "device_revoked"}
  }
  // auth.device, auth.userId, auth.orgId now available
  // ... see §5.3 ...
});
```

### 5.3 DB transaction

```sql
UPDATE devices
SET status = 'revoked', revoked_at = NOW()
WHERE id = $deviceId AND revoked_at IS NULL
RETURNING id;
```

- `rowCount = 1`：軟撤銷成功 → 204
- `rowCount = 0`：device 已 revoked（與 PR3 ingest 認證流程的 `device_revoked` 路徑一致）→ 410

同 transaction 插入 audit log：

```ts
await tx.insert(auditLogs).values({
  action: "device.self_revoked",          // new action type
  actorUserId: auth.userId,
  orgId: auth.orgId,
  resourceType: "device",
  resourceId: auth.device.id,
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
| 204 No Content | (empty) | 成功撤銷 |
| 410 Gone | `{"error":"device_already_revoked"}` | device 已被撤銷（idempotent；daemon 視為等同成功） |
| 401 Unauthorized | `{"error":"invalid_token" \| "key_revoked" \| "device_revoked"}` | 沿用 PR3 三種 sentinel |
| 500 | `{"error":"internal"}` | DB 例外 |

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
    if u.Scheme != "https" && !allowInsecure {
        return fmt.Errorf("api_base_url must be https:// (got %q); use --insecure to override", u.Scheme)
    }
    return nil
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

策略：

- `len(Patterns) > MaxPatternCount`：整個 set 拒絕（return error），caller fallback 用 stale cache 或 bundled default
- 個別 pattern 超過 `MaxRegexSrcLen`：走既有「per-pattern fault-tolerant」邏輯 — 該 pattern 跳過 + aggregate error 列出，其他 pattern 繼續使用

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
user      CLI            Server           Keychain       FS
 |         |                |                |            |
 | uninst  |                |                |            |
 |-------->|                |                |            |
 | y       |                |                |            |
 |-------->|                |                |            |
 |         | DELETE /v1/devices/me           |            |
 |         |--------------->|                |            |
 |         |    204         |                |            |
 |         |<---------------|                |            |
 |         | Delete(deviceID)                |            |
 |         |-------------------------------->|            |
 |         |    ok           |               |            |
 |         |<--------------------------------|            |
 |         | RemoveAll(~/.caliber-agent/)                 |
 |         |--------------------------------------------->|
 |         |    ok                                        |
 |         |<---------------------------------------------|
 | Removed:|                                              |
 |  ✓ ...  |                                              |
 |<--------|                                              |
```

**順序：遠端 → keychain → 本地檔**。理由：

1. 遠端先：用 keychain 內的 token 認證，必須在 keychain 刪除前完成
2. keychain 再刪：失去這把鑰匙後本機不能再呼叫 server
3. 最後刪檔：含 `config.toml`（device_id 來源），失去這個無法定位要刪哪個 keychain entry

### 7.4 uninstall degraded paths

| 場景 | 行為 |
|---|---|
| `--keep-remote` | 跳過 step 1；stdout `Skipped remote revoke (--keep-remote). Manually revoke at <api_base_url>/dashboard/devices.`；繼續 step 2 + 3 |
| 遠端 401 / network / 5xx | step 1 印 `[warn]`；繼續 step 2 + 3；最終清單把 remote 行改為 `✗ remote (failed: ...)`；退出碼 0 |
| keychain ErrNotFound | step 2 印 `[warn] keychain entry already absent`；繼續 step 3 |
| `RemoveAll` 失敗 | step 3 印 `[error]`；退出碼 1 |
| user 拒絕 confirm (`n`) | exit 130，0 side effect |
| 未 enroll 就 uninstall | `config.Load() == ErrNotEnrolled` → 早期 exit 1 |

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
  → DELETE /v1/devices/me → keychain.Delete → RemoveAll(~/.caliber-agent/)
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
| `pause` | 成功（含重複） | IO 失敗（極罕見） | — | — |
| `resume` | 成功（含未 pause） | IO 失敗 | — | — |
| `status` | 成功 | 未 enroll | — | — |
| `uninstall` | 全部清理（含遠端 best-effort 失敗） | 本地清理失敗 | — | user 取消 / non-TTY 無 `--yes` |

### 8.2 邊界情境

| 情境 | 處理 |
|---|---|
| `pause` 期間 `run` 收到 SIGINT | graceful exit 130；sentinel 保留；下次 `run` 仍空轉直到 `resume` |
| 長期 paused 後 `run` | 正常空轉，每 60s 一行 `[paused] skipping tick`（log 噪音可接受） |
| `uninstall` step 1 完成、step 2 中 SIGINT | exit 130；user 重跑 `uninstall` 時 step 1 拿到 410 idempotent → 繼續完成 step 2 + 3 |
| `uninstall` step 3 中 SIGINT | exit 130；部分檔案已刪除；user 重跑會走 `--keep-remote` 路徑清理剩餘 |
| `add-path` 對相對路徑 `./foo` | 拒絕 + `[error] add-path requires absolute path` exit 64 |
| `add-path` 對 broken symlink | `EvalSymlinks` 失敗 → `[error] cannot resolve path: <err>` exit 1 |
| `remove-path` 對 broken symlink | 跳過 `EvalSymlinks`、以 input 字串比對 IncludePaths；找到則移除 |
| `status` JSON 模式 IO 失敗 | stdout 印 `{"error":"..."}` exit 1（特殊輸出契約） |
| `add-path` / `uninstall` 在 non-TTY 環境無 `--yes` | 印 `non-interactive shell detected; pass --yes to confirm` exit 130 |

### 8.3 `uninstall` 部分失敗的退出碼語意

| 場景 | 退出碼 | 理由 |
|---|---|---|
| 全部 3 步成功 | 0 | 顯然 |
| step 1 失敗（遠端）、step 2 + 3 成功 | **0** | 本地完全乾淨；user 看 stdout 警告知道要手動 revoke |
| step 1 + 2 成功、step 3 失敗（RemoveAll） | 1 | 本地殘留檔案，user 必須處理 |
| step 1 成功、step 2 失敗（keychain） | **0** | 罕見；step 3 仍乾淨 |
| 未 enroll 就跑 uninstall | 1 | `ErrNotEnrolled` 早期 exit |

**設計原則**：「本地清理成功 = uninstall 對 user 的承諾達成」。只有本地 RemoveAll 失敗才回 1。

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
TestResume_RemovesSentinel
TestResume_NotPaused_NoOp

TestStatus_HappyPath_Human
TestStatus_JSON_StructuredOutput
TestStatus_NotEnrolled_Exit1
TestStatus_Paused_ReflectedInOutput

TestUninstall_HappyPath_AllThreeSteps
TestUninstall_YesFlag_SkipsPrompt
TestUninstall_KeepRemote_SkipsServer
TestUninstall_RemoteFails_LocalStillCleaned_Exit0
TestUninstall_KeychainNotFound_Continues
TestUninstall_LocalCleanupFails_Exit1
TestUninstall_DeclinedConfirm_Exit130_NoSideEffect
TestUninstall_NonTTY_NoYes_Exit130
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
TestRedactionSetCompile_RejectsTooManyPatterns
TestRedactionSetCompile_AtBoundary
```

#### api 層

```
TestRevokeSelf_204_Success
TestRevokeSelf_410_Idempotent_NoError
TestRevokeSelf_401_InvalidToken
TestRevokeSelf_401_KeyRevoked
TestRevokeSelf_500_ReturnsAPIError
TestRevokeSelf_NetworkError_Wrapped
```

### 9.3 Server-side 整合測試

`apps/api/tests/integration/rest/devicesRevokeSelf.test.ts`，7 cases：

1. 200 happy path → 204 + DB row `revokedAt` 設值 + audit log 寫入
2. 重複呼叫 → 第二次 410 device_already_revoked
3. invalid token → 401 invalid_token
4. revoked key → 401 key_revoked
5. revoked device → 401 device_revoked
6. ak_* token（非 cda_*）→ 401 invalid_token
7. concurrent revoke（10× Promise.all）→ 1× 204 + 9× 410（與 #159 enrollment race 同 pattern）

Regression：

```
ingest.test.ts:       POST after self-revoke → 401 device_revoked
devicesEnroll.test.ts: unchanged, run as regression
```

### 9.4 Privacy / 合規 regression tests

特別重要的反退化哨：

```
TestUninstall_DoesNotTouchHomeOutsideCaliberAgent
  // RemoveAll 只動 ~/.caliber-agent/，斷言 ~/.claude 和 ~/.codex 未被觸碰

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
pnpm exec vitest run tests/integration/rest/devicesRevokeSelf.test.ts
pnpm exec vitest run tests/integration/rest/devicesEnroll.test.ts   # regression
pnpm exec vitest run tests/integration/rest/ingest.test.ts          # regression
pnpm -r build
```

### 9.6 CI

`agent-ci.yml` 與 server `lint-type-test` workflows 自動 pickup。本 PR 不新增 workflow 檔。

## 10. Public Contract (frozen at PR4)

PR4 merge 後這些介面凍結，未來 PR 只能擴充、不能 break。

### 10.1 Server REST

| Endpoint | Method | Auth | 凍結點 |
|---|---|---|---|
| `/v1/devices/me` | DELETE | Bearer cda_* | 204 / 410 / 401 / 500 響應碼語意 |

### 10.2 Agent CLI surface

| 子命令 | args / flags | 凍結點 |
|---|---|---|
| `add-path <path>` | flag `--yes` | consent banner 必印（除 `--yes`）；輸入正規化 EvalSymlinks + Clean |
| `remove-path <path>` | — | broken symlink 不阻擋移除 |
| `pause` | — | sentinel-based、idempotent |
| `resume` | — | 同上反向 |
| `status` | flag `--json` | **零網路呼叫**；human + JSON 兩種輸出 |
| `uninstall` | flags `--yes` `--keep-remote` | 三步順序：remote → keychain → fs；本地清成功即 exit 0 |
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
| **R4.** `uninstall` 與 `run` 同時執行：terminal A 跑 daemon、terminal B 跑 uninstall | `RemoveAll(~/.caliber-agent/)` 後 daemon 下個 tick 嘗試 `SaveState` 會失敗 → `[error] save state` log → daemon 自然 exit；README 寫明 uninstall 前先停 run |
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
