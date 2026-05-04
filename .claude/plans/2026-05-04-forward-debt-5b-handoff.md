# Forward Debt 5b — OAuth Callback + Admin tRPC + probeAccount

**Goal**: ship Tasks 5.5/5.6/5.7/5.8 (deferred from PR #35) as a single
focused PR.  All forward dependencies are now satisfied by the merged
Part 9 route layer (PR #43-#51), so this can land end-to-end without
stubbing.

Read this in conjunction with:
- `.claude/plans/2026-05-04-plan-5a-handoff.md` — overall Plan 5A status.
- `.claude/plans/2026-04-28-plan-5a-design.md` — design source of truth.
  Sections §5.5, §5.6, §5.7, §5.8 cover this PR's scope.
- `.claude/plans/2026-04-28-plan-5a-implementation.md` — per-task plan.

---

## Scope

| Task | What | Where |
|---|---|---|
| **5.5** | OAuth callback HTTP listener | `apps/gateway/src/routes/oauthCallback.ts` (new) |
| **5.6** | Admin tRPC mutations: `oauthStart` + `oauthComplete` + `probe` | `apps/api/src/trpc/routers/accounts.ts` (extend) |
| **5.7** | `completeOAuthFlow` runtime — exchange code → store credential | `apps/gateway/src/oauth/completeFlow.ts` (new) |
| **5.8** | `probeAccount` — verify credential by hitting `/v1/responses` | `apps/gateway/src/oauth/probeAccount.ts` (new) |

End-to-end flow:

```
Admin UI                          tRPC                          gateway
  │                                │                                │
  │ click "Add OpenAI account"     │                                │
  ├───────────────────────────────►│                                │
  │                                │ oauthStart({platform})         │
  │                                ├───────────────────────────────►│ generateAuthURL
  │                                │  authUrl, state, codeVerifier  │
  │                                │◄───────────────────────────────┤ stash {state→
  │                                │                                │ verifier} in Redis
  │ open authUrl in popup ◄────────┤                                │ (TTL ~10min)
  │                                │                                │
  │ user authenticates with OpenAI │                                │
  │ OpenAI redirects to            │                                │
  │ <gateway>/oauth/callback?code= │                                │
  │ X&state=Y                      │                                │
  ├──────────────────────────────────────────────────────────────►  │ TASK 5.5
  │                                │                                │ verify state
  │                                │                                │ → exchangeCode
  │                                │                                │ → store credential
  │                                │                                │ → mark probing
  │                                │                                │ → probeAccount
  │ 302 redirect back to UI ◄──────────────────────────────────────┤ → mark active
  │ with ?account_id=Z             │                                │
  │                                │                                │
  │ UI polls accounts.get(Z) ◄─────┤                                │
  │ status=active, tier=plus       │                                │
```

---

## Existing surface (reuse — DON'T re-implement)

### `apps/gateway/src/oauth/types.ts`
- `OAuthService` — has `generateAuthURL` + `exchangeCode`.  Use this.
- `TokenSet` — canonical token shape.
- `OAuthRefreshError` / `OAuthRefreshTokenInvalid` — error classes.

### `apps/gateway/src/oauth/registry.ts`
- `OAuthRegistry` — central lookup.
- `getOAuthService(registry, platform)` — returns the platform's
  `OAuthService` instance.

### `apps/gateway/src/oauth/openai/index.ts`
- `registerOpenAIOAuth(registry, deps)` — composes the 4 OpenAI pieces.
  Already wired in Part 5.  PR 5b just consumes via `getOAuthService`.

### `apps/gateway/src/oauth/pkce.ts`
- `generatePKCEVerifier()` / `generateCodeChallenge(verifier)` /
  `generateState()` — for the auth URL.

### `apps/api/src/trpc/routers/accounts.ts`
- `create` (line 147): existing token-paste OAuth flow (admin pastes
  `{access_token, refresh_token, expires_at}` JSON into `credentials`
  field).  PR 5b adds a structured alternative — keep both.
- Cipher pattern (line 209-221): `encryptCredential` from
  `@aide/gateway-core` + insert into `credential_vault`.  Reuse this in
  `completeOAuthFlow`.

### `apps/gateway/src/routes/responses.ts`
- `/v1/responses` (POST).  `probeAccount` posts a tiny request here
  with the new credential's account_id and verifies a 2xx comes back.

### Database schema
- `upstream_accounts` — already has `status` enum (`active` /
  `oauth_invalid` / `revoked`).  Add intermediate `probing` value if
  needed (separate migration — see Open Questions below).
- `credential_vault.oauth_expires_at` — already populated when we
  decrypt.

---

## Implementation outline

### Task 5.5: callback listener (`apps/gateway/src/routes/oauthCallback.ts`)

```ts
// Plan 5A Forward debt 5b — Task 5.5
// HTTP handler at GET /oauth/callback?code=...&state=...
//
// 1. Look up `state` in Redis (set by oauthStart 10min earlier);
//    extract codeVerifier + accountId.
// 2. Call OAuthService.exchangeCode → TokenSet.
// 3. Encrypt + insert into credential_vault for the pre-created
//    account row (oauthStart inserted a placeholder with status=
//    'pending_oauth').
// 4. Mark account status='probing'; kick probeAccount in the
//    background (don't block the redirect on it — 5-10s probe is too
//    slow for a redirect).
// 5. 302 redirect to UI's success page with ?account_id=<id>.
// 6. On any error: redirect to UI's error page with ?reason=<code>.

import type { FastifyInstance } from "fastify";
export async function oauthCallbackRoutes(app, opts) {
  app.get("/oauth/callback", async (req, reply) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error) return redirectError(reply, opts.adminUiBaseUrl, error);
    // ... lookup state, exchangeCode, store, probe-async, redirect
  });
}
```

**Redis key shape** (used by both 5.5 + 5.6):
- Key: `aide:gw:oauth:state:<state-uuid>`
- Value: JSON `{ accountId, codeVerifier, platform, redirectUri }`
- TTL: 600s (10 min — admin needs time to authenticate).

### Task 5.6: tRPC mutations (`accounts.ts` extension)

```ts
// Plan 5A Forward debt 5b — Task 5.6
//
// oauthStart: creates a placeholder account row + writes the
// {state→codeVerifier} mapping to Redis, returns authUrl.
oauthStart: permissionProcedure(...).mutation(async ({ ctx, input }) => {
  const { authUrl, state, codeVerifier } = await getOAuthService(
    ctx.registry, input.platform,
  ).generateAuthURL({ redirectURI: callbackUri(ctx.env) });
  const account = await ctx.db.insert(upstreamAccounts).values({
    ...placeholderFields,
    status: "pending_oauth",
  }).returning().then(rows => rows[0]);
  await ctx.redis.setex(
    `aide:gw:oauth:state:${state}`,
    600,
    JSON.stringify({ accountId: account.id, codeVerifier, platform: input.platform }),
  );
  return { authUrl, accountId: account.id };
}),

// oauthComplete: rarely called directly — the callback handler is the
// primary path.  Exposed for the "paste callback URL" fallback flow
// (admin copies the redirected URL from a non-cooperating browser).
oauthComplete: permissionProcedure(...).mutation(async ({ ctx, input }) => {
  return completeOAuthFlow(ctx, { state: input.state, code: input.code });
}),

// probe: manual re-probe (e.g. after key rotation).
probe: permissionProcedure(...).mutation(async ({ ctx, input }) => {
  return probeAccount(ctx, input.accountId);
}),
```

### Task 5.7: `completeOAuthFlow` (`apps/gateway/src/oauth/completeFlow.ts`)

```ts
export async function completeOAuthFlow(deps, input: { state, code }) {
  // 1. Pop state from Redis (atomic — DEL after read so a second
  //    callback hit gets no-such-state).
  const stored = await deps.redis.get(`aide:gw:oauth:state:${input.state}`);
  if (!stored) throw new OAuthFlowError("invalid_state");
  await deps.redis.del(`aide:gw:oauth:state:${input.state}`);
  const { accountId, codeVerifier, platform } = JSON.parse(stored);

  // 2. Exchange code for tokens.
  const tokens = await getOAuthService(deps.registry, platform).exchangeCode({
    code: input.code,
    codeVerifier,
    redirectURI: callbackUri(deps.env),
  });

  // 3. Encrypt + insert credential.
  const sealed = encryptCredential({
    masterKeyHex: deps.env.CREDENTIAL_ENCRYPTION_KEY,
    accountId,
    plaintext: JSON.stringify({
      type: "oauth",
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at: tokens.expiresAt.toISOString(),
    }),
  });
  await deps.db.insert(credentialVault).values({
    accountId, nonce: sealed.nonce, ciphertext: sealed.ciphertext,
    authTag: sealed.authTag, oauthExpiresAt: tokens.expiresAt,
  });

  // 4. Flip status to 'probing' and probe (the caller decides whether
  //    to await or fire-and-forget).
  await deps.db.update(upstreamAccounts).set({ status: "probing" }).where(eq(upstreamAccounts.id, accountId));
  return { accountId };
}
```

### Task 5.8: `probeAccount` (`apps/gateway/src/oauth/probeAccount.ts`)

```ts
export async function probeAccount(deps, accountId: string) {
  // 1. Resolve credential (uses existing resolveCredential + the new
  //    OAuth refresh path — gives us a known-good access_token).
  const credential = await resolveCredential(deps.db, accountId, {...});
  // 2. Fire a minimal /v1/responses call directly via callUpstreamResponses.
  //    Tiny prompt so we don't waste tokens.  ~5 input tokens / ~1 output.
  const result = await callUpstreamResponses({
    baseUrl: deps.env.UPSTREAM_OPENAI_BASE_URL,
    body: Buffer.from(JSON.stringify({
      model: "gpt-4o-mini",
      input: "ping",
      max_output_tokens: 1,
    })),
    credential,
  });
  // 3. Update status:
  //    - 200 → status='active'
  //    - 401/403 → status='oauth_invalid', alert ops
  //    - other → leave as 'probing', let cron retry (or fail-fast?
  //      design call — see Open Questions)
  if (result.kind === "json" && result.status === 200) {
    await deps.db.update(upstreamAccounts).set({ status: "active" }).where(eq(upstreamAccounts.id, accountId));
    return { ok: true };
  } else if (result.status === 401 || result.status === 403) {
    await deps.db.update(upstreamAccounts).set({ status: "oauth_invalid" }).where(eq(upstreamAccounts.id, accountId));
    return { ok: false, reason: "credential_rejected" };
  }
  return { ok: false, reason: `upstream_${result.status}` };
}
```

---

## Open questions to resolve before coding

1. **`status` enum addition.** Current `upstream_accounts.status` is
   `active | oauth_invalid | revoked`.  Need to add `pending_oauth`
   (between row insert and callback) and `probing` (between callback
   and probe success).  → Migration 0012.  Alternatively, encode
   transient states via a separate `oauth_state` column to avoid an
   enum migration; design §5.6 doesn't specify.  **Recommend**:
   migration 0012 — `status` is already a typed enum, splitting it
   reduces query complexity downstream.

2. **`probeAccount` failure handling on transient errors** (5xx /
   network).  Two camps: fail-fast (mark `probing` → user retries)
   vs. background-retry (worker re-probes after 30s × 3 attempts).
   **Recommend**: fail-fast for first-account-creation, since the
   admin is sitting at the UI waiting; background retry would
   delay the UX more than just letting them click "retry".

3. **Callback redirect target.** Where does the admin UI live —
   `apps/web/admin/accounts/[id]`?  Need a config var for the base
   URL.  Add `ADMIN_UI_BASE_URL` to `ServerEnv` if not already there.

4. **Token-paste fallback path** (existing `accounts.create` with
   `type: "oauth"` and JSON in `credentials`).  Keep working for
   ops who can't run the browser flow (sub2api supported this).
   No changes needed; just make sure the new `oauthStart` /
   `oauthComplete` doesn't accidentally break it.

5. **State CSRF binding.**  Current plan binds state to
   `{accountId, codeVerifier}` only.  Should also bind to admin
   userId so a leaked redirect URL can't be claimed by a different
   admin.  → `oauthStart` writes `userId: ctx.user.id`; callback
   handler refuses if `req.gwUser.id !== stored.userId`.  Easy
   add — recommend including from day 1.

6. **OAuthService availability check.**  `getOAuthService(registry,
   "anthropic")` throws "not registered" because Anthropic is still
   on the old `runtime/oauthRefresh.ts` (decision A11 — refactor
   in 5D).  PR 5b should gate `oauthStart`/`oauthComplete` to
   `platform: "openai"` only.  Anthropic OAuth keeps using the
   token-paste path until 5D.

---

## Test plan (target ≥80% coverage on new modules)

### Unit tests
- `apps/gateway/tests/oauth/completeFlow.test.ts`
  - happy path (state lookup → exchangeCode mock → credential write → status update)
  - invalid state → throws `OAuthFlowError`
  - exchangeCode error → throws + state already DEL'd (idempotency)
  - state TTL expiry → treated as invalid
- `apps/gateway/tests/oauth/probeAccount.test.ts`
  - 200 → status='active'
  - 401 → status='oauth_invalid'
  - 5xx → status unchanged, returns failure reason
  - mocks `callUpstreamResponses` directly

### Integration tests
- `apps/gateway/tests/routes/oauthCallback.integration.test.ts`
  - happy path: pre-stash state → GET /oauth/callback → 302 with
    account_id query param + DB rows correct.
  - missing state cookie → redirect with error.
  - userId mismatch → redirect with error.
- `apps/api/tests/integration/trpc/accounts-oauth.integration.test.ts`
  - `oauthStart` → returns authUrl, creates pending row, sets Redis key.
  - `oauthComplete` (manual fallback) → completes flow.
  - `probe` → flips status correctly.

### Manual QA (post-merge)
- Real OpenAI Codex client_id flow against staging gateway.
- Token-paste fallback still works.

---

## Migration 0012 (if going with enum-extension approach)

```sql
-- 0012_account_pending_oauth_status.sql
ALTER TYPE upstream_account_status ADD VALUE IF NOT EXISTS 'pending_oauth';
ALTER TYPE upstream_account_status ADD VALUE IF NOT EXISTS 'probing';
```

Drizzle equivalent: bump the enum in `packages/db/src/schema.ts`,
run `pnpm --filter @aide/db generate`, commit the SQL.

Add an index for cleanup of stale `pending_oauth` rows older than
the Redis state TTL (10min):
```sql
CREATE INDEX upstream_accounts_pending_oauth_created_idx
  ON upstream_accounts (created_at)
  WHERE status = 'pending_oauth';
```

---

## Branch + PR shape

- Branch: `feat/plan-5a-pr5b-oauth-callback-flow`
- Estimate: ~1500-2000 LOC across `apps/api`, `apps/gateway`,
  `packages/db` (migration only).  Borderline split candidate; if
  it grows past 2500 LOC, consider splitting into:
  - **5b-1**: callback listener + completeOAuthFlow + migration 0012
    (gateway-side only)
  - **5b-2**: tRPC mutations + probe + UI wiring (apps/api side)

- Commit format: `feat(plan-5a): OAuth callback flow + admin tRPC + probeAccount (PR 5b)`
- PR body sections: Summary / Open questions resolved / Test plan / Manual QA checklist

---

## How to start the next session

```
讀 .claude/plans/2026-05-04-forward-debt-5b-handoff.md。
從 Forward debt 5b 動工。先決定 Open questions 1-3，然後開
feat/plan-5a-pr5b-oauth-callback-flow 分支。
```

Open questions 1-3 should be answered upfront — the rest are
implementation details that can be resolved while coding.
