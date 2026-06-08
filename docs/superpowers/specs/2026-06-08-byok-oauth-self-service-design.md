# P2 — BYOK 用戶自助 OAuth 連結 設計

**日期：** 2026-06-08
**狀態：** 已核可，待寫實作計畫
**範圍：** BYOK 後續階段 P2（P1 user-scoped upstreams、P3 status dashboard 之後）

---

## 1. 目標

讓 BYOK 終端用戶在 dashboard **自助綁定自己的 OAuth 憑證**（OpenAI codex OAuth 與 Claude Max / Anthropic OAuth），無需 operator 介入、無需手動貼 token bundle。今日 BYOK 只支援貼 api_key；本期加 OAuth 連結與重新授權。

產出的是 **user-owned oauth 上游**，套用 P1 的 `routing_policy`（pool/own/own_then_pool）與排程隔離，並由既有 OAuth refresh 機制透明自動續期。

### 非目標（本期不做）

- Hosted redirect 回呼（`/oauth/callback` 自動接 code）— 受 redirect 註冊限制，改用手動貼碼。
- 為 operator 網域另向供應商註冊新 OAuth client。
- operator 端 OAuth 管理 UI（admin `create` 早已支援 oauth type，不在本期）。
- Gemini/Antigravity 等其他平台 OAuth。

---

## 2. 關鍵決策（brainstorm 定案）

| 決策 | 選擇 | 理由 |
|------|------|------|
| 流程模型 | **A. 手動貼授權碼** | 繞過 redirect_uri 註冊限制；OpenAI codex + Claude Max 既有 client_id 都支援 loopback/顯示碼。Hosted redirect 需註冊本網域，Claude Max 未必開放 |
| 套件邊界 | **A. OAuthService 下移 gateway-core** | `apps/api` 不 import `apps/gateway`；把無狀態 service 搬到共用 core，api in-process 呼叫，無新網路面 |
| 平台範圍 | **OpenAI + Anthropic 同時** | Anthropic 常數 env 可覆寫 + `ENABLE_ANTHROPIC_OAUTH` flag + 計畫含實測確認步驟 |
| UX 入口 | **擴充現有登錄對話框** | 單一入口；platform 選完後「貼 API key｜OAuth 連結」二選一 |
| 重新授權 | **含** | refresh_token 被撤銷時讓自助真的門到底 |
| flow-state | **Redis 伺服器端** | codeVerifier（PKCE 秘密）永不離開伺服器；貼合既有 redis flow 樣式；不破壞「零 schema」 |

---

## 3. 既有資產與缺口（探查結論）

### 已具備
- **OpenAI codex OAuth service 完整**（`apps/gateway/src/oauth/openai/openaiOAuthService.ts`：`generateAuthURL`/`exchangeCode`，PKCE S256）。
- **OAuthService 介面**（`apps/gateway/src/oauth/types.ts`）：`generateAuthURL(opts:{redirectURI?}) → {authUrl,state,codeVerifier}`；`exchangeCode(opts:{code,codeVerifier,redirectURI?}) → TokenSet{accessToken,refreshToken,expiresAt,tokenType?,scope?}`。
  - **P2 介面增修（隨 gateway-core 搬移一併做）**：`generateAuthURL` 的回傳加 `redirectURI`（service 回它實際採用的值，作為唯一真實來源，讓 initiate 存進 flow、不需自行知道每平台常數）。既有 openai service 測試同步加斷言此欄位。
- **PKCE helpers**（`apps/gateway/src/oauth/pkce.ts`）：`generatePKCEVerifier`/`generateCodeChallenge`(S256)/`generateState` — 平台無關，可直接重用。
- **OAuth refresh 機制對 user-owned oauth 上游透明**（`maybeRefreshOAuth` 只依 accountId 讀 vault；user_id 只是 registerOwn 的過濾條件）。
- **Anthropic refresh policy 已定**（`apps/gateway/src/oauth/policies.ts` `ANTHROPIC_REFRESH_POLICY`）。
- **admin `create` 已支援 oauth type**；credential 明文 envelope `{type:"oauth",access_token,refresh_token,expires_at}` + 加密路徑（buildCredentialPlaintext/encryptCredential）皆現成。
- **api 有 Redis**（`ctx.redis`）。

### Anthropic 已知常數（來自既有 refresh 路徑）
- `clientId = 9d1c250a-e61b-44d9-88ed-5944d1962f5e`（Claude Code client）。
- `tokenEndpoint = https://console.anthropic.com/v1/oauth/token`（env `GATEWAY_ANTHROPIC_OAUTH_TOKEN_URL` 可覆寫）。
- token 回應 `{access_token, refresh_token, expires_in}`；**request body 是 JSON**（非 urlencoded）。

### Anthropic 未知常數（風險，需實測確認）
- `authorizeEndpoint`：**未在程式碼**。最佳已知預設 `https://claude.ai/oauth/authorize`。
- `scopes`：**未在程式碼**。最佳已知預設 **`user:profile user:inference user:sessions:claude_code`**（依 Anthropic Claude Code 官方 env docs `CLAUDE_CODE_OAUTH_SCOPES` 範例 — 對應 Claude Max / Claude Code subscription OAuth）。`org:create_api_key`（Console key creation flow）**不在本期預設**，如需可經 env override。
- 手動 `redirectURI`（顯示 `code#state` 的回呼）：最佳已知預設 `https://console.anthropic.com/oauth/code/callback`。
- **全部以 env 可覆寫常數 + 預設值落地，`ENABLE_ANTHROPIC_OAUTH` flag 閘住，計畫含「operator 跑一次真實 OAuth 校正常數」收尾步驟。**

---

## 4. 元件 / 檔案結構

### 4.1 gateway-core（新共用 oauth — 無狀態）
| 檔案 | 內容 | 動作 |
|------|------|------|
| `packages/gateway-core/src/oauth/types.ts` | `OAuthService` / `TokenSet` 介面 | 自 apps/gateway 搬入 |
| `packages/gateway-core/src/oauth/pkce.ts` | generatePKCEVerifier / generateCodeChallenge / generateState | 搬入 |
| `packages/gateway-core/src/oauth/openai/{codexConstants,openaiOAuthService}.ts` | OpenAI 無狀態 service + 常數 | 搬入 |
| `packages/gateway-core/src/oauth/anthropic/anthropicConstants.ts` | authorize/token/clientId/scopes/redirectURI（env 可覆寫，預設見 §3） | **新建** |
| `packages/gateway-core/src/oauth/anthropic/anthropicOAuthService.ts` | generateAuthURL + exchangeCode（JSON token body、解析 `code#state`） | **新建** |
| `packages/gateway-core/src/oauth/serviceRegistry.ts` | `getOAuthService(platform, opts) → OAuthService`（純服務，無 refresher/provider） | **新建** |

> apps/gateway 既有 `oauth/registry.ts`/refresher/provider/refreshApi 改 import 核心的 `OAuthService`/`TokenSet`/pkce/openai service；其 TokenRefresher/TokenProvider/refreshApi/vault/policies **留在 apps/gateway**（需 vault/redis runtime）。搬移為機械式，須保留 gateway 既有測試全綠。

### 4.2 apps/api（tRPC `accounts.ts` + 小工具）
| 項目 | 內容 |
|------|------|
| `initiateOAuth`（新） | input `{ platform: enum["openai","anthropic"], targetUpstreamId?: uuid }`；`account.manage_own` 權限；`getOAuthService(platform).generateAuthURL()` → `{authUrl,state,codeVerifier,redirectURI}`（service 回它實際使用的 redirectURI）→ `redis.set("oauth-flow:"+state, JSON{userId,platform,codeVerifier,redirectURI,targetUpstreamId?,createdAt}, "EX", 600)`；回 `{ authUrl, flowId: state }`。**redirectURI 必須一併存入** — OpenAI token exchange 要求 exchange 時的 redirect_uri 與 authorize 時一致（既有測試 pin 住），complete 用 flow 裡的值、不從當下 env/default 重推 |
| `completeOAuth`（新） | input `{ flowId: string, pastedValue: string }`；讀 `oauth-flow:<flowId>`（無→`PRECONDITION_FAILED`「授權逾時」）；用 **`parsePastedCode(pastedValue, platform)`**（§4.4）取 `{code, returnedState}`；驗 `returnedState===flowId`（不符或 state 空→`BAD_REQUEST` CSRF）、`flow.userId===ctx.user.id`（不符→`FORBIDDEN`）；`exchangeCode({code,codeVerifier:flow.codeVerifier,redirectURI:flow.redirectURI})`（用 flow 裡的 redirectURI；失敗→`BAD_REQUEST`「授權碼無效」）；buildCredentialPlaintext("oauth", JSON{access_token,refresh_token,expires_at}) + encrypt；**targetUpstreamId 有**＝重新授權（擁有權檢查 user_id=caller ∧ type=oauth ∧ 未刪 → 更新 vault + rotatedAt **並比照既有 reonboard 重設健康欄位**：`status:"active", schedulable:true, expiresAt:<新>, oauthRefreshFailCount:0, oauthRefreshLastError:null, tempUnschedulableUntil:null, tempUnschedulableReason:null` — 否則原本因 oauth_invalid/expired 被暫停的帳號重授後仍不可排程、badge 仍錯）／**無**＝首次（insert upstream_accounts{user_id:caller,team_id:null,type:"oauth",platform,name 預設} + credential_vault）；`redis.del`；回上游 |
| `getOAuthService`（新工具） | 依 platform 取核心服務；anthropic 受 `ctx.env.ENABLE_ANTHROPIC_OAUTH` 閘（關→`NOT_FOUND`/未啟用） |
| `registerOwn` | **不動**（仍 api_key-only；OAuth 不經此路） |

複用：`buildCredentialPlaintext`/`encryptCredential`/`requireMasterKeyHex`/`resolveUserPrimaryOrgId`/`_shared.ts`。

### 4.4 貼碼格式差異（重要 — 兩平台不同）
兩供應商在手動模式呈現授權碼的方式不同，`completeOAuth` 必須容忍兩種；解析放在 **api 層的 `parsePastedCode(pastedValue, platform)` 小工具**（驗 state 在此、exchange 收到乾淨 code）：
- **Anthropic（Claude Max）**：授權後頁面顯示單一字串 `<code>#<state>` → `split("#")` 取 `{code, returnedState}`。
- **OpenAI codex**：loopback 重導到 `http://localhost:1455/auth/callback?code=X&state=Y`。本機無 server，該頁不會載入屬**預期**；UI 指示用戶從**網址列**複製整個 URL。`parsePastedCode` 對 openai：以 URL/query 解析取 `code`+`state`。**裸 code（無 state）一律拒絕** — state 無法比對就破壞 INV-O2，故 `parsePastedCode` 回 state 空、completeOAuth 一律 `BAD_REQUEST`「請貼上含 state 的完整網址」。（亦容忍 `code#state` 格式作為備援。）
- UI 文案需依 platform 給對應指示（Anthropic：「貼上畫面顯示的代碼」；OpenAI：「從網址列複製 localhost 開頭的整個網址貼上」）。

### 4.3 apps/web
| 檔案 | 內容 |
|------|------|
| `components/upstreams/UpstreamRegisterDialog.tsx`（改） | platform 選完後「憑證方式」切換：API key（現有 textarea）｜OAuth（渲染 wizard） |
| `components/upstreams/OAuthConnectWizard.tsx`（新） | Step1 Connect → `initiateOAuth` → 開 authUrl(新分頁)+顯示貼碼欄（**依 platform 給對應貼碼指示**，見 §4.4）；Step2 貼值 → Submit → `completeOAuth({flowId, pastedValue})` → 成功 toast+關閉+`listOwn.invalidate()`。**可帶 targetUpstreamId 供重新授權重用** |
| `components/upstreams/UpstreamOwnList.tsx`（改） | oauth 列且 status∈{expired,oauth_invalid,error} 時顯示「重新授權」→ 開 wizard 帶 targetUpstreamId |
| `messages/{5 catalogs}.json`（改） | `oauth.*` namespace |

---

## 5. 資料流

```
[UI] 選 platform + OAuth → Connect
        │ initiateOAuth({platform, targetUpstreamId?})
[api]  getOAuthService(platform).generateAuthURL() → {authUrl,state,codeVerifier}
        redis SET oauth-flow:<state> {userId,platform,codeVerifier,targetUpstreamId?} EX 600
        → {authUrl, flowId:state}
[UI]  開 authUrl(新分頁) → 用戶在 claude.ai/openai 授權 → 供應商顯示授權碼
        (Anthropic: code#state / OpenAI: localhost?code=&state= 網址)
        用戶貼回 → completeOAuth({flowId, pastedValue})
[api]  讀 redis flow → parsePastedCode → 驗 state==flowId & userId==caller
        exchangeCode → TokenSet → 建 oauth 憑證 + 加密
        targetUpstreamId? 更新該上游 vault : insert 新 user-owned oauth 上游
        redis DEL → 回上游
[gw]   既有 refresh 機制透明續期；P1 own 路由生效
```

---

## 6. 錯誤處理

| 情況 | 結果 |
|------|------|
| flow 逾時/不存在 | `PRECONDITION_FAILED`「授權逾時，請重新開始」 |
| state 不符（CSRF） | `BAD_REQUEST` |
| flow.userId ≠ caller | `FORBIDDEN` |
| exchangeCode 失敗（碼無效/過期） | `BAD_REQUEST`「授權碼無效或已過期」 |
| 重新授權目標非本人 oauth 上游 | `FORBIDDEN` |
| anthropic 但 flag 關 | `NOT_FOUND`（功能未啟用） |

flow-state 於**成功與終局失敗皆刪除**；user-friendly 訊息；不洩漏 token 或內部細節。

---

## 7. 安全 / 不變式

- **INV-O1**：`codeVerifier` 永不離開伺服器（僅存 Redis，完全不回前端）。
- **INV-O2**：state CSRF — completeOAuth 驗證 pastedValue 內回傳的 state 等於儲存的 flowId。
- **INV-O3**：擁有權 — 新建/更新都綁 `ctx.user.id`；重新授權只更新「caller 擁有的 oauth 上游」；`flow.userId` 必須等於 caller。
- **INV-O4**：一次性 — flow-state 用後即刪，防重放。
- **INV-O5**：產出 user-owned（`user_id` 設、`team_id` null）→ P1 隔離成立（pool 不排程 user-owned、own=self）。
- token 經既有 `credentialCipher` 加密；流程任何環節不記錄 token/code/codeVerifier。

---

## 8. 測試（TDD，必加，目標 80%+）

### gateway-core
- `anthropicOAuthService.generateAuthURL`：URL 含 client_id / scopes / `code_challenge_method=S256` / state；回 `{authUrl,state,codeVerifier,redirectURI}`（含實際採用的 redirectURI）。
- openai service 搬移後，既有測試 + 新增 `generateAuthURL` 回傳含 `redirectURI` 的斷言皆綠。
- `anthropicOAuthService.exchangeCode`：JSON body、`grant_type=authorization_code`、解析 `{access_token,refresh_token,expires_in}` → TokenSet；錯誤回應 → 拋錯。
- 搬移後 openai 既有測試仍綠。

### apps/api — `parsePastedCode(pastedValue, platform)`（單元）
- Anthropic：`"<code>#<state>"` → `{code,state}`；無 `#` → 視整串為 code、state 空（後續 state 比對失敗 → BAD_REQUEST）。
- OpenAI：`"http://localhost:1455/auth/callback?code=X&state=Y"` → `{code:"X",state:"Y"}`；**裸 code（無 state）→ state 空 → completeOAuth `BAD_REQUEST`（rejected，不容忍）**。
- 去除前後空白；畸形輸入 → 安全回傳（code 或 state 空 → completeOAuth 視為 `BAD_REQUEST`）。

### apps/api（integration，比照 usage/accounts 測試）
- `initiateOAuth`：寫入 Redis flow-state（key/TTL/payload 正確）、回 authUrl；anthropic flag 關 → `NOT_FOUND`。
- `completeOAuth`：首次 → insert user-owned oauth 上游 + vault；重新授權（targetUpstreamId）→ 更新既有上游 vault、不新增列，**且健康欄位被重設**（前置一個 `status:"error",schedulable:false,oauthRefreshFailCount:3,tempUnschedulableUntil:<未來>` 的失效 oauth 上游，重授後斷言 `status="active",schedulable=true,oauthRefreshFailCount=0,tempUnschedulableUntil=null`）；flow 逾時 → `PRECONDITION_FAILED`；state 不符/空（含 OpenAI 裸 code）→ `BAD_REQUEST`；flow.userId≠caller → `FORBIDDEN`；重放（第二次同 flowId）→ 失敗；重新授權目標非本人 → `FORBIDDEN`；exchangeCode 用 flow 裡的 redirectURI（非當下 default）。
- INV-O5：建立的列 `user_id=caller, team_id=null, type=oauth`。

### apps/web（Vitest + Testing Library，mock trpc）
- 登錄對話框 OAuth 方式渲染、與 api_key 切換。
- `OAuthConnectWizard`：Connect→initiate（mock 回 authUrl）→ 顯示貼碼欄 → Submit→complete（mock 成功）→ 關閉+invalidate；complete 失敗顯示錯誤。
- `UpstreamOwnList`：expired/oauth_invalid 的 oauth 列顯示「重新授權」並帶 targetUpstreamId；健康 oauth 列不顯示。

### Anthropic 常數實測確認（計畫收尾，operator 手動）
跑一次真實 Claude Max OAuth，確認 authorize 端點 / scopes / 手動 redirect 顯示碼格式，校正 `anthropicConstants` 預設或部署 env；翻轉 `ENABLE_ANTHROPIC_OAUTH`。

---

## 9. 部署備註
- 新 env：`ENABLE_ANTHROPIC_OAUTH`（預設關，實測確認後開）、`ANTHROPIC_OAUTH_AUTHORIZE_URL` / `ANTHROPIC_OAUTH_SCOPES` / `ANTHROPIC_OAUTH_REDIRECT_URI`（皆有最佳已知預設）。
- **零 schema 變更 / 零 migration**（flow-state 在 Redis；oauth 上游用既有 upstream_accounts/credential_vault）。
- 影響 image：gateway-core 變動 → api + gateway + web 都重建。
