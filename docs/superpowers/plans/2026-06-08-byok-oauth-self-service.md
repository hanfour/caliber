# P2 — BYOK 用戶自助 OAuth 連結 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 BYOK 用戶在 dashboard 自助綁定自己的 OpenAI codex / Claude Max OAuth 憑證（手動貼授權碼流程），並能重新授權失效的 oauth 上游。

**Architecture:** 把無狀態的 OAuth 啟動/交換（`generateAuthURL`/`exchangeCode` + PKCE + 平台常數）下移到 `packages/gateway-core/oauth`（新 subpath 匯出），`apps/api` in-process 呼叫；新建 `AnthropicOAuthService`。兩支 tRPC（`initiateOAuth`/`completeOAuth`）以 Redis 短命 flow-state 夾住手動貼碼流程。`apps/gateway` 的 refresh runtime 不動，僅把被搬走的型別/常數改 re-export 自 gateway-core。前端擴充登錄對話框 + 重新授權鈕。

**Tech Stack:** TypeScript / tsc workspace packages、tRPC（protectedProcedure + `can()` RBAC）、ioredis、Zod、Next.js + react-hook-form + next-intl、Vitest。

**Spec:** `docs/superpowers/specs/2026-06-08-byok-oauth-self-service-design.md`

---

## File Structure

| 檔案 | 職責 | 動作 |
|------|------|------|
| `packages/gateway-core/package.json` | 加 `./oauth` subpath 匯出 | Modify |
| `packages/gateway-core/src/oauth/types.ts` | `OAuthService`（generateAuthURL 回傳加 `redirectURI`）/`TokenSet`/`OAuthRefreshError`/`OAuthRefreshTokenInvalid` | Create（自 gateway 搬入 + 改） |
| `packages/gateway-core/src/oauth/pkce.ts` | PKCE helpers | Create（搬入） |
| `packages/gateway-core/src/oauth/openai/codexConstants.ts` | OpenAI 常數 | Create（搬入） |
| `packages/gateway-core/src/oauth/openai/openaiTokenParser.ts` | `parseTokenResponse` | Create（搬入） |
| `packages/gateway-core/src/oauth/openai/openaiOAuthService.ts` | OpenAI service（generateAuthURL 回 `redirectURI`） | Create（搬入 + 改） |
| `packages/gateway-core/src/oauth/anthropic/anthropicConstants.ts` | Anthropic 常數（env 可覆寫、預設見 spec §3） | Create |
| `packages/gateway-core/src/oauth/anthropic/anthropicTokenParser.ts` | Anthropic token 回應解析 | Create |
| `packages/gateway-core/src/oauth/anthropic/anthropicOAuthService.ts` | Anthropic service（JSON body、`code#state`） | Create |
| `packages/gateway-core/src/oauth/serviceRegistry.ts` | `resolveOAuthService(platform, env)`（env 注入常數 + anthropic flag 閘） | Create |
| `packages/gateway-core/src/oauth/index.ts` | oauth barrel | Create |
| `apps/gateway/src/oauth/types.ts` | re-export 搬走的 4 符號自 core；保留 gateway-only 型別 | Modify |
| `apps/gateway/src/oauth/pkce.ts` / `openai/{codexConstants,openaiTokenParser,openaiOAuthService}.ts` | 刪除（已入 core） | Delete |
| `apps/gateway/src/oauth/openai/{index,openaiTokenRefresher}.ts`、`registry.ts` | 改 import 自 core | Modify |
| `packages/config/src/env.ts` | `ENABLE_ANTHROPIC_OAUTH` + 3 個 anthropic oauth env | Modify |
| `apps/api/src/trpc/routers/oauth/parsePastedCode.ts` | 貼碼解析（per-platform） | Create |
| `apps/api/src/trpc/routers/accounts.ts` | `initiateOAuth` / `completeOAuth`（首次 + 重新授權） | Modify |
| `apps/web/src/components/upstreams/OAuthConnectWizard.tsx` | 連結精靈（首次 + 重授重用） | Create |
| `apps/web/src/components/upstreams/UpstreamRegisterDialog.tsx` | 憑證方式切換（api_key / OAuth） | Modify |
| `apps/web/src/components/upstreams/UpstreamOwnList.tsx` | 失效 oauth 列加「重新授權」鈕 | Modify |
| `apps/web/messages/{5 catalogs}.json` | `upstreams.oauth.*` | Modify |

**執行順序（依賴）：** Task 1–3（gateway-core 搬移 + 重接）→ 4–6（Anthropic service + registry）→ 7（config env）→ 8–11（api parsePastedCode + initiate/complete + reauth）→ 12（i18n，前端測試前置）→ 13–14（web wizard + dialog/list）→ 15（實測確認 + 部署備註）。

---

## Task 1: gateway-core oauth 地基（subpath 匯出 + types + pkce）

**Files:**
- Modify: `packages/gateway-core/package.json`
- Create: `packages/gateway-core/src/oauth/types.ts`
- Create: `packages/gateway-core/src/oauth/pkce.ts`
- Create: `packages/gateway-core/src/oauth/index.ts`
- Test: `packages/gateway-core/tests/oauth/pkce.test.ts`

- [ ] **Step 1: 加 `./oauth` subpath 匯出**

在 `packages/gateway-core/package.json` 的 `exports` 物件，於 `"./package.json"` 之前插入：

```json
    "./oauth": {
      "types": "./dist/oauth/index.d.ts",
      "import": "./dist/oauth/index.js",
      "default": "./dist/oauth/index.js"
    },
```

- [ ] **Step 2: 建 core types.ts（OAuthService 回傳加 `redirectURI`）**

`packages/gateway-core/src/oauth/types.ts`：

```ts
// Shared, stateless OAuth init/exchange contracts. The refresh runtime
// (TokenProvider/TokenRefresher/RefreshPolicy/RefreshApi) stays in
// apps/gateway; only the pieces apps/api needs for the interactive flow
// live here.

export type Platform = "anthropic" | "openai" | "gemini" | "antigravity";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tokenType?: string;
  scope?: string;
}

export interface OAuthService {
  platform: Platform;
  // Returns the redirectURI it actually used so callers (initiateOAuth)
  // can persist it and pass the SAME value to exchangeCode (PKCE/OAuth
  // require redirect_uri symmetry).
  generateAuthURL(opts: { redirectURI?: string }): Promise<{
    authUrl: string;
    state: string;
    codeVerifier: string;
    redirectURI: string;
  }>;
  exchangeCode(opts: {
    code: string;
    codeVerifier: string;
    redirectURI?: string;
  }): Promise<TokenSet>;
}

export class OAuthRefreshError extends Error {
  constructor(
    message: string,
    public readonly platform?: Platform,
  ) {
    super(message);
    this.name = "OAuthRefreshError";
  }
}

export class OAuthRefreshTokenInvalid extends OAuthRefreshError {
  constructor(
    message: string,
    public readonly platform: Platform,
  ) {
    super(message, platform);
    this.name = "OAuthRefreshTokenInvalid";
  }
}
```

- [ ] **Step 3: 建 core pkce.ts（自 gateway 原樣搬入）**

`packages/gateway-core/src/oauth/pkce.ts`：

```ts
import { createHash, randomBytes } from "node:crypto";

export function generatePKCEVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return sha256Base64Url(verifier);
}

export function generateState(): string {
  return randomBytes(16).toString("base64url");
}
```

- [ ] **Step 4: 建 oauth barrel**

`packages/gateway-core/src/oauth/index.ts`：

```ts
export * from "./types.js";
export * from "./pkce.js";
```

- [ ] **Step 5: 寫 pkce 測試**

`packages/gateway-core/tests/oauth/pkce.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  generatePKCEVerifier,
  generateCodeChallenge,
  generateState,
  sha256Base64Url,
} from "../../src/oauth/pkce.js";

describe("pkce", () => {
  it("verifier is 43-char base64url (32 bytes)", () => {
    expect(generatePKCEVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("challenge = base64url(sha256(verifier)) S256", () => {
    const v = "test-verifier";
    expect(generateCodeChallenge(v)).toBe(sha256Base64Url(v));
    expect(generateCodeChallenge(v)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("state is 22-char base64url (16 bytes)", () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
```

- [ ] **Step 6: 跑測試 + build**

Run: `pnpm --filter @caliber/gateway-core test -- pkce && pnpm --filter @caliber/gateway-core build`
Expected: PASS（3/3）、build 產出 `dist/oauth/index.js`。

- [ ] **Step 7: Commit**

```bash
git add packages/gateway-core/package.json packages/gateway-core/src/oauth/ packages/gateway-core/tests/oauth/
git commit -m "feat(gateway-core): oauth subpath — OAuthService (redirectURI return) + pkce"
```

---

## Task 2: 搬移 OpenAI service 到 gateway-core（generateAuthURL 回 redirectURI）

**Files:**
- Create: `packages/gateway-core/src/oauth/openai/codexConstants.ts`
- Create: `packages/gateway-core/src/oauth/openai/openaiTokenParser.ts`
- Create: `packages/gateway-core/src/oauth/openai/openaiOAuthService.ts`
- Modify: `packages/gateway-core/src/oauth/index.ts`
- Test: `packages/gateway-core/tests/oauth/openai/openaiOAuthService.test.ts`

- [ ] **Step 1: 搬入 codexConstants.ts（內容與 `apps/gateway/src/oauth/openai/codexConstants.ts` 完全相同）**

`packages/gateway-core/src/oauth/openai/codexConstants.ts` — 將 `apps/gateway/src/oauth/openai/codexConstants.ts` 的整個檔案內容原樣複製（含 `OPENAI_CODEX_OAUTH`、`OPENAI_API_BASE`、`CHATGPT_BACKEND_API`）。不改任何值。

- [ ] **Step 2: 搬入 openaiTokenParser.ts（改 import 來源）**

`packages/gateway-core/src/oauth/openai/openaiTokenParser.ts` — 複製 `apps/gateway/src/oauth/openai/openaiTokenParser.ts`，僅把第一行 import 改成：

```ts
import { OAuthRefreshError, type TokenSet } from "../types.js";
```

（其餘 `parseTokenResponse` 函式內容原樣保留。）

- [ ] **Step 3: 搬入 openaiOAuthService.ts，generateAuthURL 回傳加 `redirectURI`**

`packages/gateway-core/src/oauth/openai/openaiOAuthService.ts` — 複製 `apps/gateway/src/oauth/openai/openaiOAuthService.ts`，imports 改為：

```ts
import {
  generateCodeChallenge,
  generatePKCEVerifier,
  generateState,
} from "../pkce.js";
import { OAuthRefreshError, type OAuthService } from "../types.js";
import { OPENAI_CODEX_OAUTH } from "./codexConstants.js";
import { parseTokenResponse } from "./openaiTokenParser.js";
```

並把 `generateAuthURL` 的 `return` 改成（加 `redirectURI`）：

```ts
      return { authUrl: url.toString(), state, codeVerifier, redirectURI };
```

（`exchangeCode` 等其餘不變。）

- [ ] **Step 4: barrel 加 openai 匯出**

在 `packages/gateway-core/src/oauth/index.ts` 末尾加：

```ts
export * from "./openai/codexConstants.js";
export * from "./openai/openaiTokenParser.js";
export * from "./openai/openaiOAuthService.js";
```

- [ ] **Step 5: 移植 + 擴充 service 測試（含 redirectURI 回傳斷言）**

把 `apps/gateway/tests/oauth/openai/openaiOAuthService.test.ts` 複製到 `packages/gateway-core/tests/oauth/openai/openaiOAuthService.test.ts`，import 來源改為 `../../../src/oauth/openai/openaiOAuthService.js`。在既有 redirect_uri pinning 測試（約 line 152）內，於 `generateAuthURL` 之後加一行斷言新欄位：

```ts
  expect(auth.redirectURI).toBe(customURI);
```

並新增一個預設 redirectURI 測試：

```ts
  it("generateAuthURL returns the default redirectURI when none given", async () => {
    const svc = createOpenAIOAuthService({ fetch: makeFakeFetch([]).fakeFetch });
    const auth = await svc.generateAuthURL({});
    expect(auth.redirectURI).toBe("http://localhost:1455/auth/callback");
    expect(new URL(auth.authUrl).searchParams.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    );
  });
```

- [ ] **Step 6: 跑測試**

Run: `pnpm --filter @caliber/gateway-core test -- openaiOAuthService`
Expected: PASS（既有 + 2 新斷言）。

- [ ] **Step 7: Commit**

```bash
git add packages/gateway-core/src/oauth/openai/ packages/gateway-core/src/oauth/index.ts packages/gateway-core/tests/oauth/openai/
git commit -m "feat(gateway-core): move OpenAI OAuth service + parser + constants; generateAuthURL returns redirectURI"
```

---

## Task 3: 重接 apps/gateway oauth 至 gateway-core（保持 gateway 測試綠）

**Files:**
- Modify: `apps/gateway/src/oauth/types.ts`
- Delete: `apps/gateway/src/oauth/pkce.ts`, `apps/gateway/src/oauth/openai/codexConstants.ts`, `apps/gateway/src/oauth/openai/openaiTokenParser.ts`, `apps/gateway/src/oauth/openai/openaiOAuthService.ts`
- Modify: `apps/gateway/src/oauth/openai/openaiTokenRefresher.ts`, `apps/gateway/src/oauth/openai/index.ts`, `apps/gateway/src/oauth/registry.ts`
- Delete: `apps/gateway/tests/oauth/openai/openaiOAuthService.test.ts`（已移植到 core）

- [ ] **Step 1: gateway types.ts 改成 re-export 搬走的符號 + 保留 gateway-only 型別**

把 `apps/gateway/src/oauth/types.ts` 改為（頂部）：

```ts
// The interactive-flow contracts now live in gateway-core/oauth; re-export
// them so existing gateway consumers (refresher / refreshApi / runtime)
// keep importing from "../types.js" unchanged.
export {
  type Platform,
  type TokenSet,
  type OAuthService,
  OAuthRefreshError,
  OAuthRefreshTokenInvalid,
} from "@caliber/gateway-core/oauth";
import type { Platform } from "@caliber/gateway-core/oauth";
```

保留檔案內其餘 gateway-only 宣告：`TokenProvider`、`TokenRefresher`、`RefreshErrorAction`、`LockHeldAction`、`RefreshPolicy`、`RefreshApiLike`、`OAuthLockTimeoutError`（它們引用的 `Platform` 已由上面 import 進來）。刪除原本檔內已搬走的 `Platform`/`TokenSet`/`OAuthService`/`OAuthRefreshError`/`OAuthRefreshTokenInvalid` 宣告。

- [ ] **Step 2: 加 gateway-core 為 gateway 相依**

確認 `apps/gateway/package.json` 的 dependencies 含 `"@caliber/gateway-core": "workspace:*"`（既有應已含 — 若無則加）。

- [ ] **Step 3: 刪除已搬走的檔案**

```bash
git rm apps/gateway/src/oauth/pkce.ts apps/gateway/src/oauth/openai/codexConstants.ts apps/gateway/src/oauth/openai/openaiTokenParser.ts apps/gateway/src/oauth/openai/openaiOAuthService.ts apps/gateway/tests/oauth/openai/openaiOAuthService.test.ts
```

- [ ] **Step 4: openaiTokenRefresher.ts 改 import 自 core**

把 `apps/gateway/src/oauth/openai/openaiTokenRefresher.ts` 頂部 import 改為：

```ts
import {
  OAuthRefreshError,
  OAuthRefreshTokenInvalid,
  type TokenRefresher,
} from "../types.js";
import {
  OPENAI_CODEX_OAUTH,
  parseTokenResponse,
} from "@caliber/gateway-core/oauth";
```

（`TokenRefresher` 仍來自 gateway types.ts；`OPENAI_CODEX_OAUTH`+`parseTokenResponse` 改自 core。函式體不變。）

- [ ] **Step 5: openai/index.ts 改 import createOpenAIOAuthService + 常數 re-export 自 core**

把 `apps/gateway/src/oauth/openai/index.ts`：
- `import { createOpenAIOAuthService } from "./openaiOAuthService.js";` → `import { createOpenAIOAuthService } from "@caliber/gateway-core/oauth";`
- 檔尾的 `export { OPENAI_CODEX_OAUTH, OPENAI_API_BASE, CHATGPT_BACKEND_API } from "./codexConstants.js";` → `export { OPENAI_CODEX_OAUTH, OPENAI_API_BASE, CHATGPT_BACKEND_API } from "@caliber/gateway-core/oauth";`
- `export { createOpenAIOAuthService, ... }` 那行：`createOpenAIOAuthService` 改自 core re-export — 直接 `export { createOpenAIOAuthService } from "@caliber/gateway-core/oauth";` 並保留 `createOpenAITokenProvider`/`createOpenAITokenRefresher` 的本地 re-export。

- [ ] **Step 6: registry.ts 的 OAuthService 型別改自 core（其餘留 gateway）**

`apps/gateway/src/oauth/registry.ts` 第一個 import：把 `OAuthService` 移到自 core，其餘留 gateway：

```ts
import type { OAuthService } from "@caliber/gateway-core/oauth";
import type { Platform, TokenProvider, TokenRefresher } from "./types.js";
```

- [ ] **Step 7: 跑 gateway oauth 測試 + typecheck（確認重接無回歸）**

Run: `pnpm --filter @caliber/gateway test -- oauth && pnpm --filter @caliber/gateway typecheck`
Expected: PASS（refresher/refreshApi/registry/provider 測試全綠；型別乾淨）。若有殘留 import 自被刪檔，依錯誤逐一改為 `@caliber/gateway-core/oauth`。

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/oauth/ apps/gateway/package.json
git commit -m "refactor(gateway): consume OAuth init/exchange + pkce + openai constants from gateway-core"
```

---

## Task 4: Anthropic OAuth 常數（env 可覆寫）

**Files:**
- Create: `packages/gateway-core/src/oauth/anthropic/anthropicConstants.ts`
- Modify: `packages/gateway-core/src/oauth/index.ts`
- Test: `packages/gateway-core/tests/oauth/anthropic/anthropicConstants.test.ts`

- [ ] **Step 1: 寫失敗測試**

`packages/gateway-core/tests/oauth/anthropic/anthropicConstants.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_OAUTH_DEFAULTS,
  resolveAnthropicConstants,
} from "../../../src/oauth/anthropic/anthropicConstants.js";

describe("resolveAnthropicConstants", () => {
  it("uses best-known defaults when env empty", () => {
    const c = resolveAnthropicConstants({});
    expect(c.clientId).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(c.authorizeEndpoint).toBe("https://claude.ai/oauth/authorize");
    expect(c.tokenEndpoint).toBe("https://console.anthropic.com/v1/oauth/token");
    expect(c.defaultRedirectURI).toBe(
      "https://console.anthropic.com/oauth/code/callback",
    );
    expect(c.scopes).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
    ]);
  });
  it("env overrides authorize/redirect/scopes (scopes split on whitespace)", () => {
    const c = resolveAnthropicConstants({
      ANTHROPIC_OAUTH_AUTHORIZE_URL: "https://x.test/authorize",
      ANTHROPIC_OAUTH_REDIRECT_URI: "https://x.test/cb",
      ANTHROPIC_OAUTH_SCOPES: "a:b  c:d",
    });
    expect(c.authorizeEndpoint).toBe("https://x.test/authorize");
    expect(c.defaultRedirectURI).toBe("https://x.test/cb");
    expect(c.scopes).toEqual(["a:b", "c:d"]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — `pnpm --filter @caliber/gateway-core test -- anthropicConstants` → FAIL（模組不存在）。

- [ ] **Step 3: 實作常數**

`packages/gateway-core/src/oauth/anthropic/anthropicConstants.ts`：

```ts
// Claude Max / Claude Code OAuth constants. clientId + tokenEndpoint are
// known from the existing refresh path; authorizeEndpoint + scopes +
// manual redirect are best-known defaults (Claude Code env docs) and are
// env-overridable — confirm with one live OAuth before enabling (Task 15).

export interface AnthropicOAuthConstants {
  clientId: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  defaultRedirectURI: string;
  scopes: string[];
  pkceMethod: "S256";
}

export const ANTHROPIC_OAUTH_DEFAULTS: AnthropicOAuthConstants = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeEndpoint: "https://claude.ai/oauth/authorize",
  tokenEndpoint: "https://console.anthropic.com/v1/oauth/token",
  defaultRedirectURI: "https://console.anthropic.com/oauth/code/callback",
  scopes: ["user:profile", "user:inference", "user:sessions:claude_code"],
  pkceMethod: "S256",
};

export interface AnthropicOAuthEnv {
  ANTHROPIC_OAUTH_AUTHORIZE_URL?: string;
  ANTHROPIC_OAUTH_TOKEN_URL?: string;
  ANTHROPIC_OAUTH_REDIRECT_URI?: string;
  ANTHROPIC_OAUTH_SCOPES?: string;
}

export function resolveAnthropicConstants(
  env: AnthropicOAuthEnv,
): AnthropicOAuthConstants {
  return {
    ...ANTHROPIC_OAUTH_DEFAULTS,
    authorizeEndpoint:
      env.ANTHROPIC_OAUTH_AUTHORIZE_URL ??
      ANTHROPIC_OAUTH_DEFAULTS.authorizeEndpoint,
    tokenEndpoint:
      env.ANTHROPIC_OAUTH_TOKEN_URL ?? ANTHROPIC_OAUTH_DEFAULTS.tokenEndpoint,
    defaultRedirectURI:
      env.ANTHROPIC_OAUTH_REDIRECT_URI ??
      ANTHROPIC_OAUTH_DEFAULTS.defaultRedirectURI,
    scopes: env.ANTHROPIC_OAUTH_SCOPES
      ? env.ANTHROPIC_OAUTH_SCOPES.split(/\s+/).filter(Boolean)
      : ANTHROPIC_OAUTH_DEFAULTS.scopes,
  };
}
```

- [ ] **Step 4: barrel 加匯出** — 在 `packages/gateway-core/src/oauth/index.ts` 末尾加 `export * from "./anthropic/anthropicConstants.js";`

- [ ] **Step 5: 跑測試** — `pnpm --filter @caliber/gateway-core test -- anthropicConstants` → PASS（2/2）。

- [ ] **Step 6: Commit**

```bash
git add packages/gateway-core/src/oauth/anthropic/anthropicConstants.ts packages/gateway-core/src/oauth/index.ts packages/gateway-core/tests/oauth/anthropic/
git commit -m "feat(gateway-core): Anthropic OAuth constants (env-overridable defaults)"
```

---

## Task 5: AnthropicOAuthService（generateAuthURL + exchangeCode）

**Files:**
- Create: `packages/gateway-core/src/oauth/anthropic/anthropicTokenParser.ts`
- Create: `packages/gateway-core/src/oauth/anthropic/anthropicOAuthService.ts`
- Modify: `packages/gateway-core/src/oauth/index.ts`
- Test: `packages/gateway-core/tests/oauth/anthropic/anthropicOAuthService.test.ts`

- [ ] **Step 1: 寫失敗測試**

`packages/gateway-core/tests/oauth/anthropic/anthropicOAuthService.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { createAnthropicOAuthService } from "../../../src/oauth/anthropic/anthropicOAuthService.js";
import { ANTHROPIC_OAUTH_DEFAULTS } from "../../../src/oauth/anthropic/anthropicConstants.js";

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i++]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

describe("anthropicOAuthService", () => {
  it("generateAuthURL builds claude.ai authorize URL with PKCE S256 + redirectURI", async () => {
    const svc = createAnthropicOAuthService({
      constants: ANTHROPIC_OAUTH_DEFAULTS,
      fetch: fakeFetch([]).fn,
    });
    const auth = await svc.generateAuthURL({});
    const u = new URL(auth.authUrl);
    expect(u.origin + u.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe(
      ANTHROPIC_OAUTH_DEFAULTS.clientId,
    );
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe(
      "user:profile user:inference user:sessions:claude_code",
    );
    expect(u.searchParams.get("state")).toBe(auth.state);
    expect(auth.redirectURI).toBe(ANTHROPIC_OAUTH_DEFAULTS.defaultRedirectURI);
  });

  it("exchangeCode POSTs JSON authorization_code and returns a TokenSet", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { access_token: "atk", refresh_token: "rtk", expires_in: 3600 } },
    ]);
    const svc = createAnthropicOAuthService({ constants: ANTHROPIC_OAUTH_DEFAULTS, fetch: fn, now: () => 1000 });
    const ts = await svc.exchangeCode({ code: "c", codeVerifier: "v", redirectURI: "https://x/cb" });
    expect(ts.accessToken).toBe("atk");
    expect(ts.refreshToken).toBe("rtk");
    expect(ts.expiresAt).toEqual(new Date(1000 + 3600 * 1000));
    const init = calls[0]!.init!;
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ grant_type: "authorization_code", code: "c", code_verifier: "v", redirect_uri: "https://x/cb", client_id: ANTHROPIC_OAUTH_DEFAULTS.clientId });
  });

  it("exchangeCode throws on non-2xx", async () => {
    const svc = createAnthropicOAuthService({ constants: ANTHROPIC_OAUTH_DEFAULTS, fetch: fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]).fn });
    await expect(svc.exchangeCode({ code: "c", codeVerifier: "v" })).rejects.toThrow(/anthropic_oauth_exchange_failed/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — `pnpm --filter @caliber/gateway-core test -- anthropicOAuthService` → FAIL。

- [ ] **Step 3: 實作 anthropicTokenParser.ts**

`packages/gateway-core/src/oauth/anthropic/anthropicTokenParser.ts`：

```ts
import { OAuthRefreshError, type TokenSet } from "../types.js";

// Anthropic token endpoint returns the same {access_token, refresh_token,
// expires_in} shape as OpenAI; separate parser keeps platform-correct
// error codes.
export function parseAnthropicTokenResponse(
  data: Record<string, unknown>,
  now: () => number,
): TokenSet {
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = data.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthRefreshError("anthropic_oauth_token_response_missing_access_token", "anthropic");
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new OAuthRefreshError("anthropic_oauth_token_response_missing_refresh_token", "anthropic");
  }
  if (typeof expiresIn !== "number" || expiresIn <= 0) {
    throw new OAuthRefreshError("anthropic_oauth_token_response_invalid_expires_in", "anthropic");
  }
  const tokenType = typeof data.token_type === "string" ? data.token_type : "Bearer";
  const scope = typeof data.scope === "string" ? data.scope : undefined;
  return { accessToken, refreshToken, expiresAt: new Date(now() + expiresIn * 1000), tokenType, scope };
}
```

- [ ] **Step 4: 實作 anthropicOAuthService.ts**

`packages/gateway-core/src/oauth/anthropic/anthropicOAuthService.ts`：

```ts
import {
  generateCodeChallenge,
  generatePKCEVerifier,
  generateState,
} from "../pkce.js";
import { OAuthRefreshError, type OAuthService } from "../types.js";
import type { AnthropicOAuthConstants } from "./anthropicConstants.js";
import { parseAnthropicTokenResponse } from "./anthropicTokenParser.js";

const JSON_CT = "application/json";
const TOKEN_FETCH_TIMEOUT_MS = 15_000;

export interface AnthropicOAuthServiceDeps {
  constants: AnthropicOAuthConstants;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function createAnthropicOAuthService(
  deps: AnthropicOAuthServiceDeps,
): OAuthService {
  const httpFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const c = deps.constants;

  return {
    platform: "anthropic",

    async generateAuthURL(opts) {
      const codeVerifier = generatePKCEVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateState();
      const redirectURI = opts.redirectURI ?? c.defaultRedirectURI;
      const url = new URL(c.authorizeEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", c.clientId);
      url.searchParams.set("redirect_uri", redirectURI);
      url.searchParams.set("scope", c.scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", c.pkceMethod);
      return { authUrl: url.toString(), state, codeVerifier, redirectURI };
    },

    async exchangeCode(opts) {
      const redirectURI = opts.redirectURI ?? c.defaultRedirectURI;
      let res: Response;
      try {
        res = await httpFetch(c.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": JSON_CT },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: c.clientId,
            code: opts.code,
            redirect_uri: redirectURI,
            code_verifier: opts.codeVerifier,
          }),
          signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        const reason =
          err instanceof Error && err.name === "TimeoutError"
            ? "timeout"
            : "network";
        throw new OAuthRefreshError(
          `anthropic_oauth_exchange_${reason}`,
          "anthropic",
        );
      }
      if (!res.ok) {
        await res.text().catch(() => "");
        throw new OAuthRefreshError(
          `anthropic_oauth_exchange_failed: http_${res.status}`,
          "anthropic",
        );
      }
      let data: Record<string, unknown>;
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch (_err) {
        throw new OAuthRefreshError(
          "anthropic_oauth_exchange_response_not_json",
          "anthropic",
        );
      }
      return parseAnthropicTokenResponse(data, now);
    },
  };
}
```

- [ ] **Step 5: barrel 加匯出** — 在 index.ts 末尾加 `export * from "./anthropic/anthropicTokenParser.js";` 與 `export * from "./anthropic/anthropicOAuthService.js";`

- [ ] **Step 6: 跑測試** — `pnpm --filter @caliber/gateway-core test -- anthropicOAuthService` → PASS（3/3）。

- [ ] **Step 7: Commit**

```bash
git add packages/gateway-core/src/oauth/anthropic/ packages/gateway-core/src/oauth/index.ts packages/gateway-core/tests/oauth/anthropic/
git commit -m "feat(gateway-core): AnthropicOAuthService (JSON authorization_code exchange)"
```

---

## Task 6: serviceRegistry — resolveOAuthService(platform, env)

**Files:**
- Create: `packages/gateway-core/src/oauth/serviceRegistry.ts`
- Modify: `packages/gateway-core/src/oauth/index.ts`
- Test: `packages/gateway-core/tests/oauth/serviceRegistry.test.ts`

- [ ] **Step 1: 寫失敗測試**

`packages/gateway-core/tests/oauth/serviceRegistry.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  resolveOAuthService,
  OAuthServiceUnavailableError,
} from "../../src/oauth/serviceRegistry.js";

describe("resolveOAuthService", () => {
  it("returns the openai service", () => {
    expect(resolveOAuthService("openai", { ENABLE_ANTHROPIC_OAUTH: false }).platform).toBe("openai");
  });
  it("returns the anthropic service when enabled", () => {
    expect(resolveOAuthService("anthropic", { ENABLE_ANTHROPIC_OAUTH: true }).platform).toBe("anthropic");
  });
  it("throws OAuthServiceUnavailableError for anthropic when flag off", () => {
    expect(() => resolveOAuthService("anthropic", { ENABLE_ANTHROPIC_OAUTH: false })).toThrow(OAuthServiceUnavailableError);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — FAIL（模組不存在）。

- [ ] **Step 3: 實作 serviceRegistry.ts**

`packages/gateway-core/src/oauth/serviceRegistry.ts`：

```ts
import type { OAuthService } from "./types.js";
import { createOpenAIOAuthService } from "./openai/openaiOAuthService.js";
import { createAnthropicOAuthService } from "./anthropic/anthropicOAuthService.js";
import {
  resolveAnthropicConstants,
  type AnthropicOAuthEnv,
} from "./anthropic/anthropicConstants.js";

export type SelfServicePlatform = "openai" | "anthropic";

export interface OAuthServiceEnv extends AnthropicOAuthEnv {
  ENABLE_ANTHROPIC_OAUTH: boolean;
}

// Thrown when a platform's self-service OAuth isn't available (anthropic
// behind ENABLE_ANTHROPIC_OAUTH). The api layer maps this to NOT_FOUND.
export class OAuthServiceUnavailableError extends Error {
  constructor(public readonly platform: string) {
    super(`oauth_self_service_unavailable: ${platform}`);
    this.name = "OAuthServiceUnavailableError";
  }
}

export interface ResolveOAuthServiceDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function resolveOAuthService(
  platform: SelfServicePlatform,
  env: OAuthServiceEnv,
  deps: ResolveOAuthServiceDeps = {},
): OAuthService {
  if (platform === "openai") {
    return createOpenAIOAuthService({ fetch: deps.fetch, now: deps.now });
  }
  if (platform === "anthropic") {
    if (!env.ENABLE_ANTHROPIC_OAUTH) {
      throw new OAuthServiceUnavailableError("anthropic");
    }
    return createAnthropicOAuthService({
      constants: resolveAnthropicConstants(env),
      fetch: deps.fetch,
      now: deps.now,
    });
  }
  throw new OAuthServiceUnavailableError(platform);
}
```

- [ ] **Step 4: barrel 加匯出** — index.ts 末尾加 `export * from "./serviceRegistry.js";`

- [ ] **Step 5: 跑測試 + build** — `pnpm --filter @caliber/gateway-core test -- serviceRegistry && pnpm --filter @caliber/gateway-core build` → PASS、build 綠。

- [ ] **Step 6: Commit**

```bash
git add packages/gateway-core/src/oauth/serviceRegistry.ts packages/gateway-core/src/oauth/index.ts packages/gateway-core/tests/oauth/serviceRegistry.test.ts
git commit -m "feat(gateway-core): resolveOAuthService(platform, env) + anthropic flag gate"
```

---

## Task 7: config — ENABLE_ANTHROPIC_OAUTH + anthropic oauth env

**Files:**
- Modify: `packages/config/src/env.ts`
- Test: `packages/config/tests/env.test.ts`（若存在則加；否則於本檔加最小斷言）

- [ ] **Step 1: 在 `serverEnvSchema` 加欄位**

於 `packages/config/src/env.ts` 的 `serverEnvSchema` 物件內，`ENABLE_GATEWAY: booleanUnion.default(false),` 之後加：

```ts
  ENABLE_ANTHROPIC_OAUTH: booleanUnion.default(false),
  ANTHROPIC_OAUTH_AUTHORIZE_URL: emptyAsUndefined(z.string().url().optional()),
  ANTHROPIC_OAUTH_TOKEN_URL: emptyAsUndefined(z.string().url().optional()),
  ANTHROPIC_OAUTH_REDIRECT_URI: emptyAsUndefined(z.string().url().optional()),
  ANTHROPIC_OAUTH_SCOPES: emptyAsUndefined(z.string().optional()),
```

- [ ] **Step 2: 寫/加測試**

於 config 既有 env 測試檔加（或新建 `packages/config/tests/env.oauth.test.ts`）：

```ts
import { describe, it, expect } from "vitest";
import { serverEnvSchema } from "../src/env.js";

describe("serverEnv anthropic oauth", () => {
  it("defaults ENABLE_ANTHROPIC_OAUTH to false and oauth urls to undefined", () => {
    const env = serverEnvSchema.parse({});
    expect(env.ENABLE_ANTHROPIC_OAUTH).toBe(false);
    expect(env.ANTHROPIC_OAUTH_AUTHORIZE_URL).toBeUndefined();
    expect(env.ANTHROPIC_OAUTH_SCOPES).toBeUndefined();
  });
  it("parses ENABLE_ANTHROPIC_OAUTH='true' as boolean true", () => {
    expect(serverEnvSchema.parse({ ENABLE_ANTHROPIC_OAUTH: "true" }).ENABLE_ANTHROPIC_OAUTH).toBe(true);
  });
});
```

> 注意：`serverEnvSchema.parse({})` 需其他 required 欄位有預設；若該 schema 有必填無預設欄位，改用既有測試檔的 base fixture（搜 `serverEnvSchema.parse(` 既有用法複製其 baseline input）。

- [ ] **Step 3: 跑測試** — `pnpm --filter @caliber/config test` → PASS。

- [ ] **Step 4: Commit**

```bash
git add packages/config/src/env.ts packages/config/tests/
git commit -m "feat(config): ENABLE_ANTHROPIC_OAUTH + anthropic oauth url/scope env"
```

---

## Task 8: api — parsePastedCode helper

**Files:**
- Create: `apps/api/src/trpc/routers/oauth/parsePastedCode.ts`
- Test: `apps/api/tests/unit/parsePastedCode.test.ts`

- [ ] **Step 1: 寫失敗測試**

`apps/api/tests/unit/parsePastedCode.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { parsePastedCode } from "../../src/trpc/routers/oauth/parsePastedCode.js";

describe("parsePastedCode", () => {
  it("anthropic: splits code#state", () => {
    expect(parsePastedCode("abc#xyz", "anthropic")).toEqual({ code: "abc", state: "xyz" });
  });
  it("anthropic: bare value -> empty state (rejected downstream)", () => {
    expect(parsePastedCode("abc", "anthropic")).toEqual({ code: "abc", state: "" });
  });
  it("openai: parses code+state from loopback URL", () => {
    expect(parsePastedCode("http://localhost:1455/auth/callback?code=X&state=Y", "openai")).toEqual({ code: "X", state: "Y" });
  });
  it("openai: bare code -> empty state (rejected downstream)", () => {
    expect(parsePastedCode("rawcode", "openai")).toEqual({ code: "rawcode", state: "" });
  });
  it("trims surrounding whitespace", () => {
    expect(parsePastedCode("  a#b  ", "anthropic")).toEqual({ code: "a", state: "b" });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — `pnpm --filter @caliber/api test -- parsePastedCode` → FAIL。

- [ ] **Step 3: 實作**

`apps/api/src/trpc/routers/oauth/parsePastedCode.ts`：

```ts
// Manual-paste parsing. Anthropic shows "<code>#<state>"; OpenAI codex
// loopback redirects to "http://localhost:1455/auth/callback?code=X&state=Y"
// (no local server runs — the user copies the URL from the address bar).
// A bare value with no state yields state:"" so completeOAuth rejects it
// (state CSRF check would fail anyway — see INV-O2).
export function parsePastedCode(
  pastedValue: string,
  platform: "openai" | "anthropic",
): { code: string; state: string } {
  const v = pastedValue.trim();
  if (platform === "openai" && /[?&]code=/.test(v)) {
    try {
      const u = new URL(v);
      return {
        code: u.searchParams.get("code") ?? "",
        state: u.searchParams.get("state") ?? "",
      };
    } catch {
      // not a URL — fall through to the #-split / bare handling
    }
  }
  const hashIdx = v.indexOf("#");
  if (hashIdx >= 0) {
    return { code: v.slice(0, hashIdx), state: v.slice(hashIdx + 1) };
  }
  return { code: v, state: "" };
}
```

- [ ] **Step 4: 跑測試** — PASS（5/5）。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/trpc/routers/oauth/parsePastedCode.ts apps/api/tests/unit/parsePastedCode.test.ts
git commit -m "feat(api): parsePastedCode (anthropic code#state + openai loopback url)"
```

---

## Task 9: api — initiateOAuth procedure

**Files:**
- Modify: `apps/api/src/trpc/routers/accounts.ts`
- Test: `apps/api/tests/integration/trpc/accounts.oauth.test.ts`

**Imports to add at top of accounts.ts:**
```ts
import {
  resolveOAuthService,
  OAuthServiceUnavailableError,
} from "@caliber/gateway-core/oauth";
import { parsePastedCode } from "./oauth/parsePastedCode.js";
```

- [ ] **Step 1: 寫失敗測試（用 Map 假 redis 注入，避免 testcontainer redis 相依）**

`apps/api/tests/integration/trpc/accounts.oauth.test.ts`（沿用既有 setupTestDb factories；redis 用內測 Map 假物件）：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { upstreamAccounts } from "@caliber/db";
import { eq } from "drizzle-orm";
import { resolvePermissions } from "@caliber/auth";
import {
  setupTestDb, makeOrg, makeUser, defaultTestEnv, noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { accountsRouter } from "../../../src/trpc/routers/accounts.js";

// Minimal ioredis-shaped fake with EX TTL ignored (tests run synchronously).
function fakeRedis() {
  const m = new Map<string, string>();
  return {
    store: m,
    async set(k: string, v: string) { m.set(k, v); return "OK"; },
    async get(k: string) { return m.get(k) ?? null; },
    async del(k: string) { return m.delete(k) ? 1 : 0; },
  } as unknown as import("ioredis").Redis;
}

const localRouter = router({ accounts: accountsRouter });
const createLocalCaller = createCallerFactory(localRouter);

async function callerFor(opts: { db: any; userId: string; redis: any; env?: any }) {
  const perm = await resolvePermissions(opts.db, opts.userId);
  return createLocalCaller({
    db: opts.db, user: { id: opts.userId, email: "x@x.test" }, perm,
    reqId: "test", locale: "en", env: opts.env ?? defaultTestEnv,
    redis: opts.redis, ipAddress: null, logger: noopTestLogger,
  });
}

let t: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.stop(); });

describe("accounts.initiateOAuth", () => {
  it("openai: stores flow-state in redis and returns an auth URL", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const redis = fakeRedis();
    const caller = await callerFor({ db: t.db, userId: u.id, redis });
    const res = await caller.accounts.initiateOAuth({ platform: "openai" });
    expect(res.authUrl).toContain("auth.openai.com/oauth/authorize");
    expect(res.flowId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const stored = JSON.parse((redis as any).store.get(`oauth-flow:${res.flowId}`));
    expect(stored).toMatchObject({ userId: u.id, platform: "openai", targetUpstreamId: null });
    expect(typeof stored.codeVerifier).toBe("string");
    expect(typeof stored.redirectURI).toBe("string");
  });

  it("anthropic: NOT_FOUND when ENABLE_ANTHROPIC_OAUTH is off", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: u.id, redis: fakeRedis(), env: { ...defaultTestEnv, ENABLE_ANTHROPIC_OAUTH: false } });
    await expect(caller.accounts.initiateOAuth({ platform: "anthropic" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

> 若 `accountsRouter` 尚未具名匯出，於 accounts.ts 末尾確認 `export const accountsRouter = router({ ... })` 並把新程序加進該物件。

- [ ] **Step 2: 跑測試確認失敗** — `pnpm --filter @caliber/api test:integration -- accounts.oauth.test.ts` → FAIL（程序不存在）。

- [ ] **Step 3: 實作 initiateOAuth（加進 accountsRouter）**

```ts
  initiateOAuth: protectedProcedure
    .input(
      z.object({
        platform: z.enum(["openai", "anthropic"]),
        targetUpstreamId: uuid.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      if (!can(ctx.perm, { type: "account.register_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      // Re-auth: validate target ownership + platform up-front (fail fast).
      if (input.targetUpstreamId) {
        const [row] = await ctx.db
          .select({
            id: upstreamAccounts.id,
            userId: upstreamAccounts.userId,
            platform: upstreamAccounts.platform,
            type: upstreamAccounts.type,
          })
          .from(upstreamAccounts)
          .where(
            and(
              eq(upstreamAccounts.id, input.targetUpstreamId),
              isNull(upstreamAccounts.deletedAt),
            ),
          )
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        if (
          !can(ctx.perm, {
            type: "account.manage_own",
            ownerUserId: row.userId ?? "",
          })
        ) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        if (row.type !== "oauth" || row.platform !== input.platform) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "target is not an oauth upstream of this platform",
          });
        }
      }
      let service;
      try {
        service = resolveOAuthService(input.platform, ctx.env);
      } catch (err) {
        if (err instanceof OAuthServiceUnavailableError) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        throw err;
      }
      const { authUrl, state, codeVerifier, redirectURI } =
        await service.generateAuthURL({});
      const payload = JSON.stringify({
        userId: ctx.user.id,
        platform: input.platform,
        codeVerifier,
        redirectURI,
        targetUpstreamId: input.targetUpstreamId ?? null,
      });
      await ctx.redis.set(`oauth-flow:${state}`, payload, "EX", 600);
      return { authUrl, flowId: state };
    }),
```

- [ ] **Step 4: 跑測試** — PASS（2/2）。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/trpc/routers/accounts.ts apps/api/tests/integration/trpc/accounts.oauth.test.ts
git commit -m "feat(api): initiateOAuth — own-scoped flow-state in redis + auth URL"
```

---

## Task 10: api — completeOAuth（首次連結）

**Files:**
- Modify: `apps/api/src/trpc/routers/accounts.ts`
- Modify: `apps/api/tests/integration/trpc/accounts.oauth.test.ts`

> 測試需要可控的 token exchange。`resolveOAuthService` 走真實 fetch；為避免打真網路，於本程序加一個**測試注入點**：`completeOAuth` 透過模組級 `resolveOAuthService` 呼叫，測試用 `vi.mock("@caliber/gateway-core/oauth", ...)` 攔截 `resolveOAuthService` 回傳假 service（exchangeCode 回固定 TokenSet）。沿用 Task 9 的假 redis 先以 initiateOAuth 寫入合法 flow，或直接在測試以假 redis 預置一筆 flow-state。

- [ ] **Step 1: 寫失敗測試（mock gateway-core oauth）**

在 `accounts.oauth.test.ts` 頂部加 mock（注意 hoist）：

```ts
import { vi } from "vitest";
// Mock ONLY the network-touching exchange/build, but PRESERVE the anthropic
// flag-gate (so Task 9's "anthropic disabled -> NOT_FOUND" test still holds)
// and emit a VALID 22-char base64url state (so Task 9's flowId regex holds).
vi.mock("@caliber/gateway-core/oauth", async (orig) => {
  const actual = await orig<typeof import("@caliber/gateway-core/oauth")>();
  return {
    ...actual,
    resolveOAuthService: (platform: "openai" | "anthropic", env: { ENABLE_ANTHROPIC_OAUTH: boolean }) => {
      if (platform === "anthropic" && !env.ENABLE_ANTHROPIC_OAUTH) {
        throw new actual.OAuthServiceUnavailableError("anthropic");
      }
      return {
        platform,
        async generateAuthURL() {
          return { authUrl: "https://auth.openai.com/oauth/authorize?x=1", state: "AbCdEfGhIjKlMnOpQrStUv", codeVerifier: "verifier", redirectURI: "http://localhost:1455/auth/callback" };
        },
        async exchangeCode() {
          return { accessToken: "atk", refreshToken: "rtk", expiresAt: new Date("2030-01-01T00:00:00.000Z") };
        },
      };
    },
  };
});
```

> 此 mock 保留 anthropic flag 閘（disabled→丟 `OAuthServiceUnavailableError`，api 映 NOT_FOUND），故 Task 9 的 anthropic 測試仍成立；state 用合法 22 字元 base64url（`AbCdEfGhIjKlMnOpQrStUv`），故 Task 9 的 `flowId` regex 仍成立。所有 initiate 回同一固定 state，但測試皆「建立→消費→刪除」後才下一筆，key 不衝突。

並加測試：

```ts
describe("accounts.completeOAuth (first-connect)", () => {
  it("exchanges the code and inserts a user-owned oauth upstream", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const redis = fakeRedis();
    const caller = await callerFor({ db: t.db, userId: u.id, redis });
    const init = await caller.accounts.initiateOAuth({ platform: "openai" });
    // mock generateAuthURL fixed state -> mirror it into the pasted URL
    const flowId = init.flowId;
    const pasted = `http://localhost:1455/auth/callback?code=THECODE&state=${flowId}`;
    const acct = await caller.accounts.completeOAuth({ flowId, pastedValue: pasted });
    expect(acct.type).toBe("oauth");
    expect(acct.userId).toBe(u.id);
    expect(acct.platform).toBe("openai");
    // flow-state consumed
    expect((redis as any).store.get(`oauth-flow:${flowId}`)).toBeUndefined();
    // row really exists
    const [row] = await t.db.select().from(upstreamAccounts).where(eq(upstreamAccounts.id, acct.id));
    expect(row.type).toBe("oauth");
  });

  it("rejects when state in pastedValue != flowId (CSRF / bare code)", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const redis = fakeRedis();
    const caller = await callerFor({ db: t.db, userId: u.id, redis });
    const init = await caller.accounts.initiateOAuth({ platform: "openai" });
    await expect(caller.accounts.completeOAuth({ flowId: init.flowId, pastedValue: "http://localhost:1455/auth/callback?code=THECODE&state=WRONG" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("PRECONDITION_FAILED when flow expired/missing", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: u.id, redis: fakeRedis() });
    await expect(caller.accounts.completeOAuth({ flowId: "nonexistent", pastedValue: "x#nonexistent" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
```

> mock 的 `generateAuthURL` 回固定 state `"AbCdEfGhIjKlMnOpQrStUv"`；initiateOAuth 存的 flow key 是該 state，故 `init.flowId` 等於它 — 測試一律用 `init.flowId` 拼貼 pastedValue 保證 state 一致。

- [ ] **Step 2: 跑測試確認失敗** — FAIL（completeOAuth 不存在）。

- [ ] **Step 3: 實作 completeOAuth（首次連結；reauth 分支於 Task 11 加）**

```ts
  completeOAuth: protectedProcedure
    .input(
      z.object({
        flowId: z.string().min(1).max(64),
        pastedValue: z.string().min(1).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const masterKeyHex = requireMasterKeyHex(ctx.env);

      const raw = await ctx.redis.get(`oauth-flow:${input.flowId}`);
      if (!raw) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "oauth flow expired — please start again",
        });
      }
      const flow = JSON.parse(raw) as {
        userId: string;
        platform: "openai" | "anthropic";
        codeVerifier: string;
        redirectURI: string;
        targetUpstreamId: string | null;
      };
      if (flow.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const { code, state } = parsePastedCode(input.pastedValue, flow.platform);
      if (!code || state !== input.flowId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "invalid authorization code or state",
        });
      }

      let service;
      try {
        service = resolveOAuthService(flow.platform, ctx.env);
      } catch (err) {
        if (err instanceof OAuthServiceUnavailableError) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        throw err;
      }

      let tokens;
      try {
        tokens = await service.exchangeCode({
          code,
          codeVerifier: flow.codeVerifier,
          redirectURI: flow.redirectURI,
        });
      } catch (_err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "authorization code invalid or expired",
        });
      }

      const credentialsJson = JSON.stringify({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt.toISOString(),
      });
      const oauthExpiresAt = parseOauthExpiresAt(credentialsJson);
      const plaintext = buildCredentialPlaintext("oauth", credentialsJson);

      // (Task 11 inserts the re-auth branch here, before first-connect.)

      const orgId = await resolveUserPrimaryOrgId(ctx.db, ctx.user.id);
      const account = await ctx.db.transaction(async (tx) => {
        const [acct] = await tx
          .insert(upstreamAccounts)
          .values({
            orgId,
            userId: ctx.user.id,
            teamId: null,
            name: `${flow.platform} OAuth`,
            platform: flow.platform,
            type: "oauth",
          })
          .returning();
        if (!acct) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "failed to insert upstream account",
          });
        }
        const sealed = encryptCredential({
          masterKeyHex,
          accountId: acct.id,
          plaintext,
        });
        await tx.insert(credentialVault).values({
          accountId: acct.id,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          oauthExpiresAt,
        });
        await writeAudit(tx, {
          actorUserId: ctx.user.id,
          action: "account.oauth_connected",
          targetType: "upstream_account",
          targetId: acct.id,
          orgId: acct.orgId,
          metadata: { platform: acct.platform },
        });
        return acct;
      });

      await ctx.redis.del(`oauth-flow:${input.flowId}`);
      return account;
    }),
```

- [ ] **Step 4: 跑測試** — PASS（3/3）。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/trpc/routers/accounts.ts apps/api/tests/integration/trpc/accounts.oauth.test.ts
git commit -m "feat(api): completeOAuth — first-connect inserts user-owned oauth upstream"
```

---

## Task 11: api — completeOAuth 重新授權分支

**Files:**
- Modify: `apps/api/src/trpc/routers/accounts.ts`
- Modify: `apps/api/tests/integration/trpc/accounts.oauth.test.ts`

- [ ] **Step 1: 寫失敗測試（reauth 更新既有列 + 重設健康欄位 + platform 一致）**

```ts
describe("accounts.completeOAuth (re-authorize)", () => {
  it("updates the existing oauth upstream's credential and resets health fields", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const redis = fakeRedis();
    const caller = await callerFor({ db: t.db, userId: u.id, redis });
    // first connect an oauth upstream
    const init1 = await caller.accounts.initiateOAuth({ platform: "openai" });
    const acct = await caller.accounts.completeOAuth({ flowId: init1.flowId, pastedValue: `http://x?code=C&state=${init1.flowId}` });
    // force it into a broken/paused state
    await t.db.update(upstreamAccounts).set({ status: "error", schedulable: false, oauthRefreshFailCount: 3, tempUnschedulableUntil: new Date(Date.now() + 3_600_000) }).where(eq(upstreamAccounts.id, acct.id));
    // re-authorize
    const init2 = await caller.accounts.initiateOAuth({ platform: "openai", targetUpstreamId: acct.id });
    const res = await caller.accounts.completeOAuth({ flowId: init2.flowId, pastedValue: `http://x?code=C2&state=${init2.flowId}` });
    expect(res.id).toBe(acct.id);
    const [row] = await t.db.select().from(upstreamAccounts).where(eq(upstreamAccounts.id, acct.id));
    expect(row.status).toBe("active");
    expect(row.schedulable).toBe(true);
    expect(row.oauthRefreshFailCount).toBe(0);
    expect(row.tempUnschedulableUntil).toBeNull();
    // no NEW row created
    const all = await t.db.select().from(upstreamAccounts).where(eq(upstreamAccounts.userId, u.id));
    expect(all.length).toBe(1);
  });

  it("rejects re-auth when target platform != flow.platform", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const redis = fakeRedis();
    // ENABLE_ANTHROPIC_OAUTH=true so resolveOAuthService(anthropic) reaches
    // exchange + the reauth platform check (the mismatch -> BAD_REQUEST)
    // instead of short-circuiting to NOT_FOUND on the disabled flag.
    const caller = await callerFor({ db: t.db, userId: u.id, redis, env: { ...defaultTestEnv, ENABLE_ANTHROPIC_OAUTH: true } });
    const init1 = await caller.accounts.initiateOAuth({ platform: "openai" });
    const acct = await caller.accounts.completeOAuth({ flowId: init1.flowId, pastedValue: `http://x?code=C&state=${init1.flowId}` });
    // craft a flow with platform=anthropic but target the openai row, written directly to redis
    const flowId = "anthroflow22charstate0";
    (redis as any).store.set(`oauth-flow:${flowId}`, JSON.stringify({ userId: u.id, platform: "anthropic", codeVerifier: "v", redirectURI: "https://x/cb", targetUpstreamId: acct.id }));
    await expect(caller.accounts.completeOAuth({ flowId, pastedValue: `code#${flowId}` })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
```

> 第二個測試的 `resolveOAuthService` mock 回的是 openai-shaped service（platform 欄位無關緊要，exchangeCode 回固定 TokenSet）；platform 不符的拒絕發生在 exchange 之後、寫入之前的 reauth 分支檢查。

- [ ] **Step 2: 跑測試確認失敗** — reauth 測試 FAIL（目前 completeOAuth 永遠走首次插入）。

- [ ] **Step 3: 插入 reauth 分支**

在 `completeOAuth` 內、`const plaintext = buildCredentialPlaintext(...)` 之後、`const orgId = await resolveUserPrimaryOrgId(...)` 之前，插入：

```ts
      if (flow.targetUpstreamId) {
        const [row] = await ctx.db
          .select({
            id: upstreamAccounts.id,
            userId: upstreamAccounts.userId,
            orgId: upstreamAccounts.orgId,
            platform: upstreamAccounts.platform,
            type: upstreamAccounts.type,
          })
          .from(upstreamAccounts)
          .where(
            and(
              eq(upstreamAccounts.id, flow.targetUpstreamId),
              isNull(upstreamAccounts.deletedAt),
            ),
          )
          .limit(1);
        // Collapse missing-row + not-owner into NOT_FOUND so a caller can't
        // enumerate other users' upstream IDs (matches Task 9 + the router's
        // anti-enumeration convention). The platform/type BAD_REQUEST below
        // only runs on rows the caller owns, so it leaks nothing cross-user.
        if (
          !row ||
          !can(ctx.perm, {
            type: "account.manage_own",
            ownerUserId: row.userId ?? "",
          })
        ) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        if (row.type !== "oauth" || row.platform !== flow.platform) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "target is not an oauth upstream of this platform",
          });
        }
        const sealed = encryptCredential({
          masterKeyHex,
          accountId: row.id,
          plaintext,
        });
        const rotatedAt = new Date();
        await ctx.db.transaction(async (tx) => {
          await tx
            .update(credentialVault)
            .set({
              nonce: sealed.nonce,
              ciphertext: sealed.ciphertext,
              authTag: sealed.authTag,
              oauthExpiresAt,
              rotatedAt,
            })
            .where(eq(credentialVault.accountId, row.id));
          await tx
            .update(upstreamAccounts)
            .set({
              status: "active",
              schedulable: true,
              expiresAt: oauthExpiresAt,
              oauthRefreshFailCount: 0,
              oauthRefreshLastError: null,
              tempUnschedulableUntil: null,
              tempUnschedulableReason: null,
              updatedAt: rotatedAt,
            })
            .where(eq(upstreamAccounts.id, row.id));
          await writeAudit(tx, {
            actorUserId: ctx.user.id,
            action: "account.oauth_reauthorized",
            targetType: "upstream_account",
            targetId: row.id,
            orgId: row.orgId,
            metadata: { platform: row.platform },
          });
        });
        await ctx.redis.del(`oauth-flow:${input.flowId}`);
        return { id: row.id };
      }
```

- [ ] **Step 4: 跑測試** — `pnpm --filter @caliber/api test:integration -- accounts.oauth.test.ts` → PASS（含首次 + reauth 全部）。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/trpc/routers/accounts.ts apps/api/tests/integration/trpc/accounts.oauth.test.ts
git commit -m "feat(api): completeOAuth re-authorize — update vault + reset health (manage_own + platform match)"
```

---

## Task 12: i18n — `upstreams.oauth.*`（5 catalogs）

**Files:** Modify `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json`

> 前端元件測試前置（setup 把 next-intl stub 到 en.json）。在每個 catalog 的 `upstreams` 物件內加 `oauth` 子物件。

- [ ] **Step 1: en.json `upstreams.oauth`**

```json
"oauth": {
  "method": "Credential method",
  "methodApiKey": "Paste API key",
  "methodOAuth": "Connect via OAuth",
  "connect": "Connect",
  "codeLabel": "Authorization code",
  "pasteHintAnthropic": "After authorizing, paste the code shown on the page.",
  "pasteHintOpenAI": "After authorizing, copy the full localhost URL from the address bar and paste it here.",
  "submit": "Finish connecting",
  "connectedToast": "OAuth credential connected",
  "anthropicDisabled": "Anthropic OAuth is not enabled.",
  "reauthorize": "Re-authorize",
  "reauthAriaLabel": "Re-authorize {name}",
  "reauthTitle": "Re-authorize {name}"
}
```

- [ ] **Step 2: zh-TW.json `upstreams.oauth`**

```json
"oauth": {
  "method": "憑證方式",
  "methodApiKey": "貼上 API key",
  "methodOAuth": "透過 OAuth 連結",
  "connect": "連結",
  "codeLabel": "授權碼",
  "pasteHintAnthropic": "授權後，貼上頁面顯示的代碼。",
  "pasteHintOpenAI": "授權後，從網址列複製 localhost 開頭的整個網址貼上。",
  "submit": "完成連結",
  "connectedToast": "OAuth 憑證已連結",
  "anthropicDisabled": "Anthropic OAuth 尚未啟用。",
  "reauthorize": "重新授權",
  "reauthAriaLabel": "重新授權 {name}",
  "reauthTitle": "重新授權 {name}"
}
```

- [ ] **Step 3: zh-CN.json `upstreams.oauth`**

```json
"oauth": {
  "method": "凭证方式",
  "methodApiKey": "粘贴 API key",
  "methodOAuth": "通过 OAuth 连接",
  "connect": "连接",
  "codeLabel": "授权码",
  "pasteHintAnthropic": "授权后，粘贴页面显示的代码。",
  "pasteHintOpenAI": "授权后，从地址栏复制 localhost 开头的整个网址粘贴。",
  "submit": "完成连接",
  "connectedToast": "OAuth 凭证已连接",
  "anthropicDisabled": "Anthropic OAuth 尚未启用。",
  "reauthorize": "重新授权",
  "reauthAriaLabel": "重新授权 {name}",
  "reauthTitle": "重新授权 {name}"
}
```

- [ ] **Step 4: ja.json `upstreams.oauth`**

```json
"oauth": {
  "method": "認証情報の方式",
  "methodApiKey": "API キーを貼り付け",
  "methodOAuth": "OAuth で接続",
  "connect": "接続",
  "codeLabel": "認可コード",
  "pasteHintAnthropic": "認可後、画面に表示されたコードを貼り付けてください。",
  "pasteHintOpenAI": "認可後、アドレスバーの localhost で始まる URL 全体をコピーして貼り付けてください。",
  "submit": "接続を完了",
  "connectedToast": "OAuth 認証情報を接続しました",
  "anthropicDisabled": "Anthropic OAuth は有効になっていません。",
  "reauthorize": "再認可",
  "reauthAriaLabel": "{name} を再認可",
  "reauthTitle": "{name} を再認可"
}
```

- [ ] **Step 5: ko.json `upstreams.oauth`**

```json
"oauth": {
  "method": "자격 증명 방식",
  "methodApiKey": "API 키 붙여넣기",
  "methodOAuth": "OAuth로 연결",
  "connect": "연결",
  "codeLabel": "인증 코드",
  "pasteHintAnthropic": "승인 후 페이지에 표시된 코드를 붙여넣으세요.",
  "pasteHintOpenAI": "승인 후 주소창의 localhost로 시작하는 전체 URL을 복사해 붙여넣으세요.",
  "submit": "연결 완료",
  "connectedToast": "OAuth 자격 증명이 연결되었습니다",
  "anthropicDisabled": "Anthropic OAuth가 활성화되지 않았습니다.",
  "reauthorize": "재승인",
  "reauthAriaLabel": "{name} 재승인",
  "reauthTitle": "{name} 재승인"
}
```

- [ ] **Step 6: 驗證 JSON 合法 + key 對齊**

Run: `node -e "for(const l of ['en','zh-TW','zh-CN','ja','ko']){const o=require('./apps/web/messages/'+l+'.json').upstreams.oauth; for(const k of ['method','methodApiKey','methodOAuth','connect','codeLabel','pasteHintAnthropic','pasteHintOpenAI','submit','connectedToast','anthropicDisabled','reauthorize','reauthAriaLabel','reauthTitle'])if(typeof o[k]!=='string')throw new Error(l+' missing '+k);} console.log('ok')"`
Expected: `ok`

- [ ] **Step 7: Commit**

```bash
git add apps/web/messages/
git commit -m "i18n(web): upstreams.oauth namespace (5 locales)"
```

---

## Task 13: web — OAuthConnectWizard 元件

**Files:**
- Create: `apps/web/src/components/upstreams/OAuthConnectWizard.tsx`
- Test: `apps/web/tests/components/upstreams/OAuthConnectWizard.test.tsx`

- [ ] **Step 1: 寫失敗測試**

`apps/web/tests/components/upstreams/OAuthConnectWizard.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const initiateMutate = vi.fn();
const completeMutate = vi.fn();
const openSpy = vi.fn();
vi.stubGlobal("open", openSpy);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    accounts: {
      initiateOAuth: { useMutation: (opts: any) => ({ mutate: (v: any) => { initiateMutate(v); opts.onSuccess?.({ authUrl: "https://auth.openai.com/x", flowId: "FLOW22charstate0000000" }); }, isPending: false }) },
      completeOAuth: { useMutation: (opts: any) => ({ mutate: (v: any) => { completeMutate(v); opts.onSuccess?.({ id: "a1" }); }, isPending: false }) },
    },
  },
}));
import { OAuthConnectWizard } from "@/components/upstreams/OAuthConnectWizard";

describe("OAuthConnectWizard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Connect calls initiateOAuth, opens the auth URL, then reveals the paste field", () => {
    render(<OAuthConnectWizard platform="openai" onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(initiateMutate).toHaveBeenCalledWith({ platform: "openai", targetUpstreamId: undefined });
    expect(openSpy).toHaveBeenCalledWith("https://auth.openai.com/x", "_blank", "noopener,noreferrer");
    expect(screen.getByLabelText("Authorization code")).toBeInTheDocument();
  });

  it("Submit calls completeOAuth with flowId + pastedValue then onDone", async () => {
    const onDone = vi.fn();
    render(<OAuthConnectWizard platform="openai" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    fireEvent.change(screen.getByLabelText("Authorization code"), { target: { value: "http://localhost:1455/auth/callback?code=C&state=FLOW22charstate0000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
    expect(completeMutate).toHaveBeenCalledWith({ flowId: "FLOW22charstate0000000", pastedValue: "http://localhost:1455/auth/callback?code=C&state=FLOW22charstate0000000" });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("passes targetUpstreamId through for re-authorize", () => {
    render(<OAuthConnectWizard platform="anthropic" targetUpstreamId="up1" onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(initiateMutate).toHaveBeenCalledWith({ platform: "anthropic", targetUpstreamId: "up1" });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — `pnpm --filter @caliber/web test -- OAuthConnectWizard` → FAIL（模組不存在）。

- [ ] **Step 3: 實作元件**

`apps/web/src/components/upstreams/OAuthConnectWizard.tsx`：

```tsx
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";

interface Props {
  platform: "openai" | "anthropic";
  /** Present => re-authorize an existing oauth upstream instead of creating one. */
  targetUpstreamId?: string;
  /** Called after a successful connect (caller closes + invalidates listOwn). */
  onDone: () => void;
}

export function OAuthConnectWizard({ platform, targetUpstreamId, onDone }: Props) {
  const t = useTranslations("upstreams.oauth");
  const tCommon = useTranslations("common");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [pastedValue, setPastedValue] = useState("");

  const initiate = trpc.accounts.initiateOAuth.useMutation({
    onSuccess: (res) => {
      setFlowId(res.flowId);
      window.open(res.authUrl, "_blank", "noopener,noreferrer");
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(code === "NOT_FOUND" ? t("anthropicDisabled") : e.message);
    },
  });

  const complete = trpc.accounts.completeOAuth.useMutation({
    onSuccess: () => {
      toast.success(t("connectedToast"));
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });

  if (flowId === null) {
    return (
      <Button
        onClick={() => initiate.mutate({ platform, targetUpstreamId })}
        disabled={initiate.isPending}
      >
        {t("connect")}
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {platform === "anthropic" ? t("pasteHintAnthropic") : t("pasteHintOpenAI")}
      </p>
      <textarea
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        rows={3}
        aria-label={t("codeLabel")}
        value={pastedValue}
        onChange={(e) => setPastedValue(e.target.value)}
      />
      <Button
        onClick={() => complete.mutate({ flowId, pastedValue })}
        disabled={complete.isPending || pastedValue.trim() === ""}
      >
        {complete.isPending ? tCommon("loading") : t("submit")}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: 跑測試** — PASS（3/3）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/upstreams/OAuthConnectWizard.tsx apps/web/tests/components/upstreams/OAuthConnectWizard.test.tsx
git commit -m "feat(web): OAuthConnectWizard (initiate -> open auth URL -> paste code -> complete)"
```

---

## Task 14: web — 登錄對話框憑證方式切換 + 列重新授權鈕

**Files:**
- Modify: `apps/web/src/components/upstreams/UpstreamRegisterDialog.tsx`
- Modify: `apps/web/src/components/upstreams/UpstreamOwnList.tsx`
- Test: `apps/web/tests/components/upstreams/UpstreamRegisterDialog.test.tsx`（加 OAuth 方式測試）

- [ ] **Step 1: 對話框加「憑證方式」切換（method state）+ OAuth 分支**

在 `UpstreamRegisterDialog.tsx`：
- 加 `const [method, setMethod] = useState<"api_key" | "oauth">("api_key");`（import `useState`）。
- 在 platform 選擇之後、credentials 欄位之前，加一個 method 切換（native select）：

```tsx
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{tu("oauth.method")}</span>
          <select
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={method}
            onChange={(e) => setMethod(e.target.value as "api_key" | "oauth")}
          >
            <option value="api_key">{tu("oauth.methodApiKey")}</option>
            <option value="oauth">{tu("oauth.methodOAuth")}</option>
          </select>
        </label>
```

- 當 `method === "oauth"`：不渲染 api_key 的 credentials textarea + submit，改渲染（platform 僅 anthropic/openai 支援 OAuth）：

```tsx
        {method === "oauth" ? (
          <OAuthConnectWizard
            platform={platform as "openai" | "anthropic"}
            onDone={() => {
              utils.accounts.listOwn.invalidate();
              onOpenChange(false);
            }}
          />
        ) : (
          /* existing api_key fields + submit button */
        )}
```

（import `OAuthConnectWizard`。`platform` 來自既有 `watch("platform")`。）

- [ ] **Step 2: 列加「重新授權」鈕（oauth 且失效）**

在 `UpstreamOwnList.tsx`：
- 加 `const [reauthRow, setReauthRow] = useState<UpstreamRow | null>(null);`
- 在 row actions（rotate 鈕附近），加：

```tsx
                          {row.type === "oauth" &&
                            ["expired", "error"].includes(deriveAccountStatus(row)) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                onClick={() => setReauthRow(row)}
                                aria-label={t("oauth.reauthAriaLabel", { name: row.name })}
                              >
                                <RefreshCw className="h-4 w-4" />
                              </Button>
                            )}
```

- 在檔尾的對話框群組加一個重新授權對話框（沿用既有 Dialog primitive，或最小 inline）：

```tsx
      {reauthRow && (
        <div role="dialog" aria-label={t("oauth.reauthTitle", { name: reauthRow.name })}
             className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-card">
            <h3 className="mb-3 text-sm font-medium">{t("oauth.reauthTitle", { name: reauthRow.name })}</h3>
            <OAuthConnectWizard
              platform={reauthRow.platform as "openai" | "anthropic"}
              targetUpstreamId={reauthRow.id}
              onDone={() => { utils.accounts.listOwn.invalidate(); setReauthRow(null); }}
            />
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setReauthRow(null)}>
              {tCommon("cancel")}
            </Button>
          </div>
        </div>
      )}
```

（import `OAuthConnectWizard`；`tCommon("cancel")` 需存在於 common — 若無，沿用既有取消字串 key。確認 `common.cancel` 存在：`node -e "console.log(require('./apps/web/messages/en.json').common.cancel)"`，若 undefined 則改用既有對應 key。）

- [ ] **Step 3: 對話框測試加 OAuth 方式**

在 `UpstreamRegisterDialog.test.tsx` 加（沿用既有 mock，補 initiateOAuth/completeOAuth mock）：

```tsx
  it("shows the OAuth wizard when the OAuth method is selected", async () => {
    const user = userEvent.setup();
    useMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    render(<UpstreamRegisterDialog open onOpenChange={() => {}} />);
    await user.selectOptions(screen.getByLabelText("Credential method"), "oauth");
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });
```

> 需在該測試檔的 `vi.mock("@/lib/trpc/client", ...)` 補上 `initiateOAuth`/`completeOAuth` 的 `useMutation: () => ({ mutate: vi.fn(), isPending: false })`，以及 `useUtils` 已含 `accounts.listOwn.invalidate`。

- [ ] **Step 4: 跑測試 + 全 web 套件 + typecheck**

Run: `pnpm --filter @caliber/web test && pnpm --filter @caliber/web typecheck`
Expected: PASS（含既有 + OAuthConnectWizard + 新對話框測試）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/upstreams/UpstreamRegisterDialog.tsx apps/web/src/components/upstreams/UpstreamOwnList.tsx apps/web/tests/components/upstreams/UpstreamRegisterDialog.test.tsx
git commit -m "feat(web): OAuth method in register dialog + re-authorize button on failed oauth upstreams"
```

---

## Task 15: Anthropic 常數實測確認 + 部署備註（operator 手動）

**Files:** 無程式碼變更（文件/部署）。

- [ ] **Step 1: 全套件回歸**

Run: `pnpm --filter @caliber/gateway-core test && pnpm --filter @caliber/gateway test -- oauth && pnpm --filter @caliber/web test && pnpm --filter @caliber/config test`
Expected: 全綠。（api 整合測試 `accounts.oauth.test.ts` 單檔跑：`pnpm --filter @caliber/api test:integration -- accounts.oauth.test.ts`。）

- [ ] **Step 2: 型別 + build 全綠**

Run: `pnpm --filter @caliber/gateway-core build && pnpm --filter @caliber/gateway typecheck && pnpm --filter @caliber/api typecheck && pnpm --filter @caliber/web typecheck`

- [ ] **Step 3: Anthropic OAuth 常數實測確認（operator）**

部署到一個可測環境（`ENABLE_ANTHROPIC_OAUTH=false` 先發），operator 在 dashboard 對 anthropic 走一次 initiate：
1. 確認 `claude.ai/oauth/authorize` 是否為正確 authorize 端點、scopes 是否被接受、授權後頁面顯示的碼是否為 `code#state` 格式、手動 redirect 是否為 `console.anthropic.com/oauth/code/callback`。
2. 若任一不符，設對應 env（`ANTHROPIC_OAUTH_AUTHORIZE_URL` / `ANTHROPIC_OAUTH_SCOPES` / `ANTHROPIC_OAUTH_REDIRECT_URI` / `ANTHROPIC_OAUTH_TOKEN_URL`）或修 `ANTHROPIC_OAUTH_DEFAULTS`。
3. 確認 exchange 成功、建立 oauth 上游、own 路由命中、refresh 機制續期。
4. 全部 OK 後翻轉 `ENABLE_ANTHROPIC_OAUTH=true`。

- [ ] **Step 4: 部署備註（spec §9）**
- 新 env：`ENABLE_ANTHROPIC_OAUTH`（預設關）、`ANTHROPIC_OAUTH_AUTHORIZE_URL`/`ANTHROPIC_OAUTH_TOKEN_URL`/`ANTHROPIC_OAUTH_REDIRECT_URI`/`ANTHROPIC_OAUTH_SCOPES`（皆有預設）。
- **零 schema / 零 migration**（flow-state 在 Redis；oauth 上游用既有表）。
- gateway-core 變動 → api + gateway + web 三 image 都重建。

- [ ] **Step 5: 進 superpowers:finishing-a-development-branch**

---

## 不變式回顧（對應 spec §7）

- **INV-O1**：codeVerifier 僅存 Redis flow-state，完全不回前端（initiate 只回 authUrl+flowId）。
- **INV-O2**：completeOAuth 驗 `parsePastedCode().state === flowId`，裸 code（state 空）一律 BAD_REQUEST。
- **INV-O3**：首次綁 `ctx.user.id`（register_own）；reauth 經 `manage_own(row.userId)` + `row.platform===flow.platform`；`flow.userId===caller`。
- **INV-O4**：flow-state 成功與終局失敗皆 `redis.del`（防重放）。
- **INV-O5**：產出 `user_id=caller, team_id=null, type=oauth` → P1 隔離成立。
