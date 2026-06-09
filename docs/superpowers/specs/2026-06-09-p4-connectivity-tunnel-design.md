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
| `docker/docker-compose.yml`（改） | 加 `cloudflared` 服務，`profiles: [tunnel]`（與 `gateway` 並列）；`image: cloudflare/cloudflared:2026.x.x`（pin 一個明確 tag，實作時取當時最新穩定版並寫死，不用 `latest`）；`command: ["tunnel","--no-autoupdate","run","--token","${TUNNEL_TOKEN}"]`；`depends_on: gateway`；`restart: unless-stopped`；接內網（無 ports 發佈，CF 從容器內連出）|
| `packages/config/src/env.ts`（改） | 新 env `TUNNEL_TOKEN`（`emptyAsUndefined(z.string().optional())`）；節流 3 個 env（§4.2）；`GATEWAY_ALERT_WEBHOOK_URL`（§4.3）|
| 部署 | operator 在 CF Zero Trust 建 named tunnel（public hostname → `http://gateway:3002`），取 token 設 `TUNNEL_TOKEN`，設 `GATEWAY_BASE_URL=https://<hostname>`，並把 cloudflared 容器來源納入 `GATEWAY_TRUSTED_PROXIES`（runbook §4.4 寫明）|

> CF 將真實 client IP 放 `CF-Connecting-IP` + `X-Forwarded-For`。cloudflared→gateway 為同 compose 網段，gateway 看到 cloudflared 容器 IP 為 socket peer；`GATEWAY_TRUSTED_PROXIES` 納入該網段後，Fastify 由 `X-Forwarded-For` 取真實 IP → 節流 + 每 key IP 白名單正確 key 在用戶 IP。

### 4.2 每 IP 認證失敗節流（gateway）
| 項目 | 內容 |
|------|------|
| `apps/gateway/src/middleware/ipAuthThrottle.ts`（新） | 純函式 + Redis：`checkIpBlocked(redis, ip)` / `recordAuthFailure(redis, ip, cfg)`。key `auth-fail:<ip>`（窗 TTL）、`auth-fail-block:<ip>`（封鎖 TTL）|
| `apps/gateway/src/middleware/apiKeyAuth.ts`（改） | key 查詢**先做**；**有效 → 放行（不計、不擋）**；無效路徑（回 401 前）→ 若 `checkIpBlocked` 命中 → **429 + `Retry-After`**（封鎖剩餘秒）並 return；否則 `recordAuthFailure` → 若跨門檻設 block → 本次回 429，否則維持原 401。|
| env | `GATEWAY_AUTH_FAIL_MAX`（int，預設 10）、`GATEWAY_AUTH_FAIL_WINDOW_SEC`（預設 300）、`GATEWAY_AUTH_FAIL_BLOCK_SEC`（預設 900）。三者皆 `0` 視為停用節流。|
| metric | 新 `gw_auth_fail_throttle_total`（被節流的 401 次數，counter）。沿用既有 `gw_rate_limit_fail_open_total` 概念於 Redis 錯誤時 fail-open（記 metric、不擋）。|

**演算法（lenient，DB 友善）**：
1. extractKey → **無 key header → 視為認證失敗**（與 key 無效同路徑，計入節流；防無 header 洗流量），跳到步驟 3。
2. lookup key_hash。**命中且有效 → 正常路徑（永不節流）**。
3. 命中但 revoked/expired/not-revealed，或未命中，或無 key header → 即「認證失敗」：
   a. `checkIpBlocked(ip)`：blocked → 429 + Retry-After（block 剩餘），`gw_auth_fail_throttle_total.inc()`，return。
   b. 否則 `recordAuthFailure(ip)`：`INCR auth-fail:<ip>`（首次設窗 TTL）；若 `>= MAX` → `SET auth-fail-block:<ip> 1 EX BLOCK_SEC`，本次回 429 + Retry-After；否則回原本的 401 錯誤碼。
4. Redis 任一步錯 → **fail-open**：略過節流、走原 401，`gw_rate_limit_fail_open_total.inc({op:"auth_throttle"})`。

> 無 key header 的請求：計入節流（防無 header 洗流量），與「key 無效」同視為認證失敗。

### 4.3 webhook 預算告警（gateway worker）
| 項目 | 內容 |
|------|------|
| `apps/gateway/src/workers/evaluator/budgetAlertWebhook.ts`（新） | `maybeSendBudgetAlert(deps, {orgId, event, monthToDate, budget, behavior})`：去重後 fire-and-forget POST |
| `apps/gateway/src/workers/evaluator/enforceBudgetWithMetrics.ts`（改） | 在發 `gw_llm_budget_warn_total` / `gw_llm_budget_exceeded_total` 的同處，呼叫 `maybeSendBudgetAlert`（注入 redis/fetch/webhookUrl/logger）|
| env | `GATEWAY_ALERT_WEBHOOK_URL`（`emptyAsUndefined(z.string().url().optional())`）。未設 → 整段 no-op |
| 去重 | warn：`alert-sent:warn:<orgId>:<YYYY-MM>`（`SET NX EX` 到月底約 ~35 天）；exceeded：`alert-sent:exceeded:<orgId>:<YYYY-MM>`。已存在 → 不重送 |
| payload | `{ "event": "warn"\|"exceeded", "orgId", "monthToDate": "<decimal string>", "budget": "<decimal string>", "behavior"?, "ts": "<ISO>" }`。**無任何 api key / token / 憑證** |
| 行為 | fire-and-forget（`AbortSignal.timeout(5000)`）；任何錯誤 `logger.warn` 不拋；**絕不阻斷或失敗呼叫者的請求/worker** |

### 4.4 docs runbook
- `docs/` 新 runbook（或擴充 `MULTI_DEVICE.md`）：CF named-tunnel 建置步驟（建 tunnel、public hostname→`http://gateway:3002`、取 token）、`TUNNEL_TOKEN`/`GATEWAY_BASE_URL`/`GATEWAY_TRUSTED_PROXIES`（納入 cloudflared 網段）設定、key 衛生（短 TTL/撤銷/監控用量）、節流 env 旋鈕說明、webhook payload 格式 + 範例接收端（curl/Slack）。

---

## 5. 資料流

```
用戶 SDK → https://<cf-hostname>（公開）→ Cloudflare edge → cloudflared(容器)
       → gateway:3002（內網）→ apiKeyAuth
            ├ 真實 client IP（CF-Connecting-IP / X-Forwarded-For，trustProxy 信任 cloudflared 網段）
            ├ key 有效 → 正常路由（永不節流）
            └ key 無效 → 每 IP 節流（blocked→429 / 累計→封鎖→429 / 否則 401）
budget worker → wrapEnforceBudget → warn(≥80%)/exceeded → maybeSendBudgetAlert →（Redis 去重）→ webhook POST
```

---

## 6. 錯誤處理

| 情況 | 結果 |
|------|------|
| tunnel 掛 | gateway 仍可經 VPN/LAN（profile 加法，既有存取不變） |
| Redis 掛（節流） | **fail-open**：略過節流、走原 401，`gw_rate_limit_fail_open_total.inc({op:"auth_throttle"})` |
| webhook 不通/逾時 | `logger.warn` 記錄、非致命、不阻斷請求/worker |
| `TUNNEL_TOKEN` 未設 | cloudflared 服務只在 `--profile tunnel` 啟用；未啟用＝零影響 |
| `GATEWAY_ALERT_WEBHOOK_URL` 未設 | 告警整段 no-op |

---

## 7. 安全 / 不變式

- **INV-P1**：有效 key 永不被暴力節流（只有「認證失敗 / 無 key」路徑計數與封鎖）。
- **INV-P2**：節流 + 每 key IP 白名單都 key 在**真實 client IP**（CF-Connecting-IP via trustProxy），非 tunnel/proxy IP。
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
- 無 key header 計入節流。
- Redis-down → 仍回原 401（fail-open，不誤 429）。
- 節流 metric `gw_auth_fail_throttle_total` 遞增。

### gateway — `budgetAlertWebhook`（單元，fake fetch + Redis）
- warn 首次 → POST 一次、payload shape 正確、無秘密欄位。
- 同 org 同月第二次 warn → **不再 POST**（去重）。
- exceeded → POST（含 behavior）。
- `GATEWAY_ALERT_WEBHOOK_URL` 未設 → 不 POST、不拋。
- webhook 回 500 / 逾時 → 不拋、記 log（呼叫者不受影響）。

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
