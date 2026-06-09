# P4 — 連線模型（Tunnel）設計

**日期：** 2026-06-09
**狀態：** 已核可，待寫實作計畫
**範圍：** BYOK 路線圖 P4（連線模型）— 最後一塊

---

## 1. 目標

讓 BYOK 終端用戶**無需各自安裝 VPN** 即可連到 operator 自架的 gateway，透過 **Cloudflare named tunnel** 提供穩定的公開 HTTPS URL；同時補上「公開暴露」所需的兩塊硬化：**每 IP 認證失敗暴力破解節流** 與 **org 預算超量 webhook 告警**。

設計原則：對既有 VPN（Tailscale）/ LAN 存取為**純加法**，啟用 tunnel 不改動、不弱化既有存取或驗證。

### 非目標（本期不做）
- 直接公開暴露 + 自建 reverse proxy + TLS（姿態 B）— 改用 tunnel，TLS 由 Cloudflare 處理。
- per-key quota 強制擋下（目前 per-key `quotaUsedUsd` 僅記錄不 enforce；本期告警針對既有 **org 月預算** warn/exceeded 事件，不新增 per-key 強制）。
- 短 TTL key 預設/政策。
- email/SMTP 告警（改用 webhook，零 SMTP infra）。
- Tailscale Funnel / ngrok（聚焦 Cloudflare named tunnel；其他留文件提及）。

---

## 2. 關鍵決策（brainstorm 定案）

| 決策 | 選擇 | 理由 |
|------|------|------|
| 連線姿態 | **C. Tunnel** | 降低用戶 VPN 摩擦、程式量低；TLS 由 CF 處理 |
| tunnel 形態 | **Named tunnel（token）** | 穩定公開 URL（用戶 `GATEWAY_BASE_URL` 不變）、無速率限制；需 operator CF 帳號 + token |
| 節流行為 | **只節流認證失敗** | 公開後 NAT/CGNAT 共用 IP 常見；有效 key 不受影響、不誤傷合法用戶 |
| 告警管道 | **Webhook** | 主動通知、零 SMTP；operator 自接 Slack/Discord/自建 |

---

## 3. 既有資產與缺口（探查結論）

### 已具備
- gateway/web 綁 `0.0.0.0`，compose port-map；`deploy/proxy/` 有 Caddy/Nginx 範本。
- **`GATEWAY_TRUSTED_PROXIES`（trustProxy）已接好**（`apps/gateway/src/server.ts:111-142`、`apps/api/src/server.ts:48-66`）— Fastify 依 CIDR 信任 `X-Forwarded-For`。
- **每 key IP 白/黑名單已實作**（`apps/gateway/src/middleware/apiKeyAuth.ts:115-132`，依 `req.ip`，需 trustProxy 正確）。
- apiKeyAuth：`Authorization: Bearer` / `x-api-key`，HMAC-SHA256(pepper) 查 `api_keys.key_hash`，401 涵蓋 invalid/revoked/expired/not-revealed（`PUBLIC_PATHS` 僅 `/health`）。
- **org 月預算 enforce + warn/exceeded metrics 已存在**：`apps/gateway/src/workers/evaluator/enforceBudgetWithMetrics.ts` 的 `wrapEnforceBudget`（warn ≥80% month-to-date、exceeded；`gw_llm_budget_warn_total{org_id}` / `gw_llm_budget_exceeded_total{org_id,behavior}`）。NULL 預算＝無限、不發 warn。
- Redis（`caliber:gw:` keyPrefix）已用於 rate-limit/idempotency/cache；rate-limit **fail-open** 姿態（`gw_rate_limit_fail_open_total`）。
- `docs/MULTI_DEVICE.md §2` 已列四種連線法（Tailscale / LAN / Cloudflare-ngrok / on-prem）。

### 缺口（本期補）
- ❌ **每 IP 認證失敗節流**（`GATEWAY.md §6.7` 僅一行「planned, 暫用 reverse proxy」，無細設計）。
- ❌ **cloudflared 管理服務**（目前只有文件提 `cloudflared --url`，無 compose 服務）。
- ❌ **budget 事件主動通知**（metrics 會跳，但無通知管道）。

---

## 4. 元件 / 檔案結構

### 4.1 cloudflared 管理 tunnel
| 項目 | 內容 |
|------|------|
| `docker/docker-compose.yml`（改） | 加 `cloudflared` 服務，`profiles: [tunnel]`（與 `gateway` 並列）；`image: cloudflare/cloudflared:2026.x.x`（pin 一個明確 tag，實作時取當時最新穩定版並寫死，不用 `latest`）；`command: ["tunnel","--no-autoupdate","run","--token","${TUNNEL_TOKEN}"]`；`restart: unless-stopped`；接**專屬 `tunnel` network**（無 ports 發佈，CF 從容器內連出）|
| `docker/docker-compose.yml` — **新 network** | 新增 `networks.tunnel`（internal bridge）。**只有 `gateway` 與 `cloudflared` 同時接 `tunnel` network**；其他容器（postgres/redis/web/api）不接。如此 gateway 在 `tunnel` 網段上的對等只可能是 cloudflared，杜絕同 default 網段任意容器偽造 `X-Forwarded-*` |
| `packages/config/src/env.ts`（改） | 新 env `TUNNEL_TOKEN`（`emptyAsUndefined(z.string().optional())`）；節流 3 個 env（§4.2）；`GATEWAY_ALERT_WEBHOOK_URL`（§4.3）|
| 部署 | operator 在 CF Zero Trust 建 named tunnel（public hostname → `http://gateway:3002`），取 token 設 `TUNNEL_TOKEN`，設 `GATEWAY_BASE_URL=https://<hostname>`，並把 **cloudflared 在 `tunnel` network 上的固定 IP/該 network CIDR** 設入 `GATEWAY_TRUSTED_PROXIES`（**不可**用整個 default compose / Docker CIDR）|

> **真實 client IP 來源（INV-P2）**：Cloudflare 在受信 hop 帶 `CF-Connecting-IP`（單一權威值）+ `X-Forwarded-For`（chain）。`GATEWAY_TRUSTED_PROXIES` **只信任 cloudflared 對等**（專屬 network），Fastify 才會採信前述 header。**client IP 解析優先用受信 peer 傳來的 `CF-Connecting-IP`**（單一來源、不可被多 hop XFF 注入污染）；無該 header 時退回 Fastify `req.ip`（trustProxy 解析的 XFF）。節流 + 每 key IP 白名單都用此解析出的真實 IP。> 為此 apiKeyAuth/節流改用一個小工具 `resolveClientIp(req)`（CF-Connecting-IP 優先、否則 req.ip），取代直接 `req.ip`。

### 4.2 每 IP 認證失敗節流（gateway）
| 項目 | 內容 |
|------|------|
| `apps/gateway/src/middleware/ipAuthThrottle.ts`（新） | 純函式 + Redis：`checkIpBlocked(redis, ip)` / `recordAuthFailure(redis, ip, cfg)`。key `auth-fail:<ip>`（窗 TTL）、`auth-fail-block:<ip>`（封鎖 TTL）|
| `apps/gateway/src/middleware/apiKeyAuth.ts`（改） | 見下演算法。**「認證成功」= key 狀態有效（非 revoked/expired/not-revealed）∧ 通過 IP allow/deny policy**；任何失敗（含 `ip_not_allowed`、無 key header）皆「認證失敗」並計入節流。|
| env | `GATEWAY_AUTH_FAIL_MAX`（int，預設 10）、`GATEWAY_AUTH_FAIL_WINDOW_SEC`（預設 300）、`GATEWAY_AUTH_FAIL_BLOCK_SEC`（預設 900）。三者皆 `0` 視為停用節流。|
| metric | 新 `gw_auth_fail_throttle_total`（counter，被節流而回 429 的次數）。Redis 錯誤 fail-open 時記 **`gw_redis_error_total.inc({op:"auth_throttle"})`**（沿用既有 op-label counter，非無 label 的 `gw_rate_limit_fail_open_total`）。|

**演算法（lenient）**：
1. **無 key header / malformed key（明顯非合法格式，無需查 DB）→ 認證失敗的 pre-DB fast path**：先 `checkIpBlocked(ip)`，blocked → 429（不查 DB）；否則 `recordAuthFailure` 後回 401/429。**此路徑不打 Postgres。**
2. 格式合法的 key → lookup `key_hash`。**命中、狀態有效、且通過 IP policy → 認證成功（永不節流、永不計數）**。
3. 命中但 revoked/expired/not-revealed，或 `ip_not_allowed`（IP policy 不過），或未命中 → 「認證失敗」：
   a. `checkIpBlocked(ip)`：blocked → 429 + Retry-After（block 剩餘），`gw_auth_fail_throttle_total.inc()`，return。
   b. 否則 `recordAuthFailure(ip)`：`INCR auth-fail:<ip>`（首次設窗 TTL）；若 `>= MAX` → `SET auth-fail-block:<ip> 1 EX BLOCK_SEC`，本次回 429 + Retry-After + `gw_auth_fail_throttle_total.inc()`；否則回原本的 401/403 錯誤碼。
4. Redis 任一步錯 → **fail-open**：略過節流、走原 401/403，`gw_redis_error_total.inc({op:"auth_throttle"})`。

> **DB-負載 tradeoff（誠實聲明）**：本節流主要保護「response semantics + 下游路由/upstream 資源」與防止泄漏 key 從錯 IP 無限打。**格式合法但無效的 key 仍會做一次 O(1) 索引 lookup + HMAC 才被擋**（無法不查就判定有效性）；blocked IP 持續送隨機合法格式 key 仍每次查一次 DB（cheap、indexed）。無 key header / malformed key 則 pre-DB fast-path 直接擋、不查 DB。整體前緣另有 Cloudflare edge 速率限制兜底。`ip`＝`resolveClientIp(req)`（§4.1，CF-Connecting-IP 優先）。

### 4.3 webhook 預算告警（gateway worker）
| 項目 | 內容 |
|------|------|
| `apps/gateway/src/workers/evaluator/budgetAlertWebhook.ts`（新） | `maybeSendBudgetAlert(deps, {orgId, event, monthToDate, budget, behavior})`：**送成功才月度去重**（見下） |
| `apps/gateway/src/workers/evaluator/enforceBudgetWithMetrics.ts`（改） | 在發 `gw_llm_budget_warn_total` / `gw_llm_budget_exceeded_total` 的同處，呼叫 `maybeSendBudgetAlert`（注入 redis/fetch/webhookUrl/logger）|
| env | `GATEWAY_ALERT_WEBHOOK_URL`（`emptyAsUndefined(z.string().url().optional())`）。未設 → 整段 no-op |
| **去重（send-then-mark，避免失敗永久壓掉告警）** | dedup key：warn=`alert-sent:warn:<orgId>:<YYYY-MM>`、exceeded=`alert-sent:exceeded:<orgId>:<YYYY-MM>:<behavior>`（**含 behavior**，degrade→halt 行為變更不被舊 alert 壓掉）。流程：① 若 dedup key 已存在 → skip；② 取短 TTL in-flight lock `alert-lock:<同 key>`（`SET NX EX 30`）防併發重送，取不到 → skip；③ POST webhook；④ **僅 2xx 才 `SET dedup-key 1 EX <到月底~35天>`**；非 2xx/逾時 → 不寫 dedup（記 log，下次可重試）；⑤ 釋放 in-flight lock |
| payload | `{ "event": "warn"\|"exceeded", "orgId", "monthToDate": "<decimal string>", "budget": "<decimal string>", "behavior"?, "ts": "<ISO>" }`。**無任何 api key / token / 憑證** |
| 行為 | fire-and-forget（`AbortSignal.timeout(5000)`）；任何錯誤 `logger.warn` 不拋；**絕不阻斷或失敗呼叫者的請求/worker** |

### 4.4 docs runbook
- `docs/` 新 runbook（或擴充 `MULTI_DEVICE.md`）：CF named-tunnel 建置步驟（建 tunnel、public hostname→`http://gateway:3002`、取 token）、`TUNNEL_TOKEN`/`GATEWAY_BASE_URL`/`GATEWAY_TRUSTED_PROXIES`（納入 cloudflared 網段）設定、key 衛生（短 TTL/撤銷/監控用量）、節流 env 旋鈕說明、webhook payload 格式 + 範例接收端（curl/Slack）。

---

## 5. 資料流

```
用戶 SDK → https://<cf-hostname>（公開）→ Cloudflare edge → cloudflared(容器)
       → gateway:3002（內網）→ apiKeyAuth
            ├ 真實 client IP = resolveClientIp（CF-Connecting-IP 優先；trustProxy 只信 cloudflared 對等）
            ├ key 有效 ∧ 通過 IP policy → 正常路由（永不節流）
            └ 認證失敗（無效/ip_not_allowed/無 key）→ 每 IP 節流（blocked→429 / 累計→封鎖→429 / 否則 401/403）
budget worker → wrapEnforceBudget → warn(≥80%)/exceeded → maybeSendBudgetAlert →（send-then-mark 去重）→ webhook POST
```

---

## 6. 錯誤處理

| 情況 | 結果 |
|------|------|
| tunnel 掛 | gateway 仍可經 VPN/LAN（profile 加法，既有存取不變） |
| Redis 掛（節流） | **fail-open**：略過節流、走原 401/403，`gw_redis_error_total.inc({op:"auth_throttle"})` |
| webhook 不通/逾時 | `logger.warn` 記錄、非致命、不阻斷請求/worker |
| `TUNNEL_TOKEN` 未設 | cloudflared 服務只在 `--profile tunnel` 啟用；未啟用＝零影響 |
| `GATEWAY_ALERT_WEBHOOK_URL` 未設 | 告警整段 no-op |

---

## 7. 安全 / 不變式

- **INV-P1**：認證成功（key 狀態有效 ∧ 通過 IP policy）的請求永不被暴力節流；只有認證失敗（key 無效/`ip_not_allowed`/無 key）才計數與封鎖。
- **INV-P2**：節流 + 每 key IP 白名單都 key 在 `resolveClientIp(req)` 解出的**真實 client IP**（受信 cloudflared 對等帶來的 CF-Connecting-IP 優先），非 tunnel/proxy IP；`GATEWAY_TRUSTED_PROXIES` **只信 cloudflared 對等（專屬 `tunnel` network）**，不信整個 compose CIDR。
- **INV-P3**：webhook fire-and-forget、不阻斷或失敗呼叫者、payload **無任何秘密**（無 api key/token/憑證）。
- **INV-P4**：tunnel 純加法 — 啟用不改動/弱化既有 VPN/LAN 存取或驗證。
- **INV-P5**：Redis 故障時節流 fail-open（可用性優先於暴力防護，與既有 rate-limit 一致）。

---

## 8. 測試（TDD，必加，目標 80%+）

### gateway — `ipAuthThrottle`（單元，fake Redis）
- 未達門檻：N-1 次失敗後 `checkIpBlocked`=false。
- 達門檻：第 N 次 `recordAuthFailure` 設 block；之後 `checkIpBlocked`=true、回 block 剩餘秒。
- 窗過期：超過 `WINDOW_SEC` 後計數重置。
- 停用：`MAX=0` → 永不 block。
- Redis 錯誤 → 安全回傳（不 block）。

### gateway — apiKeyAuth 整合（比照既有 apiKeyAuth 測試）
- **有效 key 從「已封鎖 IP」仍 200**（INV-P1：valid 不受節流）。
- 同 IP 連續無效 key：達門檻後回 **429 + Retry-After**（先前回 401）。
- **`ip_not_allowed`（有效 key 但 IP 不過 policy）計入節流** — 同 IP 連續從錯 IP 打有效 key，達門檻後回 429（防泄漏 key 無限打 403）。
- **無 key header / malformed key 走 pre-DB fast path**：被節流時不觸發 DB lookup（以 spy/mock db 斷言 query 未被呼叫）。
- `resolveClientIp`：帶 `CF-Connecting-IP` header（且 socket peer 受信）時，節流/IP policy 用該 IP，而非 XFF 末端或 socket peer。
- 無 key header 計入節流。
- Redis-down → 仍回原 401（fail-open，不誤 429）。
- 節流 metric `gw_auth_fail_throttle_total` 遞增。

### gateway — `budgetAlertWebhook`（單元，fake fetch + Redis）
- warn 首次（webhook 2xx）→ POST 一次、payload shape 正確、無秘密欄位、**dedup key 寫入**。
- 同 org 同月第二次 warn → **不再 POST**（dedup 命中）。
- exceeded → POST（含 behavior）；**dedup key 含 behavior** → behavior 從 degrade→halt 時仍會再送一次。
- `GATEWAY_ALERT_WEBHOOK_URL` 未設 → 不 POST、不拋。
- **webhook 回 500 / 逾時 → 不拋、記 log、且 dedup key 未寫入**（send-then-mark）→ 下次同事件**會重試**（不被永久壓掉）。
- in-flight lock：併發兩次同事件，只有一次 POST。

### config（單元）
- 新 env 預設：`TUNNEL_TOKEN`/`GATEWAY_ALERT_WEBHOOK_URL` 預設 undefined；`GATEWAY_AUTH_FAIL_MAX/WINDOW_SEC/BLOCK_SEC` 預設 10/300/900；型別正確。

### cloudflared（operator 手動 smoke）
- compose `config` 驗證服務定義合法；部署後 operator 設 `TUNNEL_TOKEN` → `docker compose --profile tunnel up -d cloudflared` 起得來 → 公開 URL 可打 `/v1/messages`（200，real IP 正確）。屬部署收尾步驟。

---

## 9. 部署備註
- 新 env：`TUNNEL_TOKEN`、`GATEWAY_ALERT_WEBHOOK_URL`、`GATEWAY_AUTH_FAIL_MAX/WINDOW_SEC/BLOCK_SEC`（皆選用/有預設）。
- **零 schema / 零 migration**（節流 + 告警去重在 Redis；無新表）。
- 影響 image：gateway（節流 + webhook）+ config 變動 → gateway/api/web 重建；cloudflared 為外部 image（無需自建）。
- 啟用 tunnel：CF 建 named tunnel → 設 `TUNNEL_TOKEN`/`GATEWAY_BASE_URL`/`GATEWAY_TRUSTED_PROXIES` → `--profile gateway --profile tunnel up -d`。
