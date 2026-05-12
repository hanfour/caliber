# Zod Validation Messages i18n — Design

**Date:** 2026-05-13
**Status:** Approved (brainstorming → spec)
**Author:** Hanfour Huang (+ Claude)
**Issue:** to-be-filed (backlog item from `project_state.md` 2026-05-12)

---

## Problem

tRPC routers (apps/api) and web forms (apps/web) validate input with Zod. The
resulting error messages — both Zod's defaults ("String must contain at least 1
character(s)", "Invalid email") and inline custom strings (`.min(1, "Name is
required")`, `.refine(..., { message: "Pick a team" })`) — are hardcoded
English. They do not follow the user's chosen locale even though `apps/web`
already has a working **next-intl** stack with five shipped locales:
`en`, `zh-TW`, `zh-CN`, `ja`, `ko`.

Concrete impact:

- A user with `NEXT_LOCALE=zh-TW` submits an empty Account name and sees
  `"Name is required"` in English instead of "名稱為必填".
- Server-side validation errors that bubble up via tRPC also surface in
  English regardless of locale.
- The validation strings sit outside the i18n catalogue, so they cannot be
  reviewed or polished alongside the rest of the UI.

## Goals

1. All Zod-produced validation messages reach the end user in the active
   locale (cookie > Accept-Language > default).
2. Five locales (`en`, `zh-TW`, `zh-CN`, `ja`, `ko`) ship with translations
   covering both Zod default issue codes and every inline custom message
   currently in the repo.
3. Both **server-side** (apps/api tRPC) and **client-side** (apps/web
   react-hook-form + zodResolver) paths translate consistently.
4. CI green; no regression in existing form behaviour.

## Non-Goals

- Native-speaker review of translations beyond the author's `zh-TW`.
  Following the existing `project_state.md` convention, `zh-CN/ja/ko`
  strings get an LLM-grade first pass and are flagged for a native review
  backlog issue.
- A full sweep of feature i18n (existing namespaces under
  `apps/web/messages/*.json` remain unchanged).
- Multi-tenant override of validation copy (e.g. branded "Acme name is
  required"). All validation copy is global.
- i18n for upstream Anthropic/OpenAI error messages relayed by the gateway
  (those come back from third-party APIs in English).

## Constraints

- Single `zod@^3.23.0` version across the monorepo. A single Zod error map
  shape works in every workspace.
- `apps/api` is an independent Fastify+tRPC server with **no next-intl
  context** — `getTranslations()` is not available there.
- `apps/web/messages/{locale}.json` already holds ~792 keys across ~30
  namespaces. Locale cookie name is `NEXT_LOCALE`. Switcher and request
  config already use this cookie.
- `apps/web/next.config.mjs` rewrites `/trpc/:path*` to
  `${API_INTERNAL_URL}/trpc/:path*`. HTTP headers (cookies +
  Accept-Language) propagate through this rewrite.

## Strategic Decisions (settled during brainstorming)

| # | Decision | Why |
|---|---|---|
| 1 | **Server-side translation** | All API consumers (web, curl, future CLIs) see locale-correct messages; client doesn't need per-error transformer logic. |
| 2 | **Sweep all inline custom messages into keys** | A one-shot clean cutover beats a long tail of English strings hiding in code. |
| 3 | **Locale propagation via shared cookie + Accept-Language logic** | Re-use the parsing that `apps/web/src/i18n/request.ts` already implements; lift it to a shared package so api and web agree. |
| 4 | **Top-level `validation.*` namespace** | One place to read all validation copy; clear translator ownership; doesn't fragment custom keys across feature namespaces. |
| 5 | **Two-PR shipping cadence (foundation → sweep)** | PR A is self-contained and verifiable on its own; PR B has the bulk diff but no architectural risk. |

## Architecture

### New package: `packages/i18n-validation/`

Single source of truth for validation-related i18n + locale resolution.

```
packages/i18n-validation/
├── src/
│   ├── locales.ts      # LOCALES, Locale, DEFAULT_LOCALE, LOCALE_COOKIE,
│   │                   # isLocale, pickFromAcceptLanguage
│   │                   # (moved from apps/web/src/i18n/locales.ts + request.ts)
│   ├── messages.ts     # loadValidationMessages(locale): ValidationMessages
│   │                   # (lazy import + in-memory cache)
│   ├── errorMap.ts     # createErrorMap(messages): z.ZodErrorMap
│   ├── runtime.ts      # localeStorage: AsyncLocalStorage<Locale>
│   │                   # runWithLocale(locale, fn), currentLocale()
│   ├── setup.ts        # setGlobalLocaleErrorMap(): wires z.setErrorMap
│   │                   # to read currentLocale() at issue-time
│   └── index.ts
├── messages/{en,zh-TW,zh-CN,ja,ko}.json   # only `validation.*` content
├── tests/
│   ├── errorMap.test.ts
│   ├── messages.test.ts          # 5-locale key-parity snapshot
│   └── runtime.test.ts
└── package.json                  # name: @caliber/i18n-validation
```

**Why `messages/` is package-local, not merged into `apps/web/messages/`:**
validation copy is consumed by Zod's error map — it never goes through
`useTranslations`. Keeping it package-local lets `apps/api` import directly
without reverse-depending on `apps/web`. `apps/web/messages/{locale}.json`
remains unchanged.

### Module responsibilities

**`locales.ts`** — pure, no runtime side effects.
- Owns `LOCALES`, `Locale`, `DEFAULT_LOCALE`, `LOCALE_COOKIE`, `isLocale()`.
- Owns `pickFromAcceptLanguage(headerValue)` (lifted verbatim from
  `apps/web/src/i18n/request.ts`).
- New helper: `resolveLocale({ cookie, acceptLanguage })` — the
  cookie-then-accept-language-then-default cascade in one function, callable
  from both apps.

**`messages.ts`**
- `loadValidationMessages(locale: Locale): ValidationMessages` — `await
  import('../messages/{locale}.json')` with an internal `Map<Locale,
  ValidationMessages>` cache. Synchronous after first load.
- `ValidationMessages` type derived from `en.json` shape so unknown keys are
  caught at compile-time inside the package.

**`errorMap.ts`** — `createErrorMap(messages): z.ZodErrorMap` returns a
function `(issue, ctx) => { message }` that:
- Inspects `issue.code` and (where relevant) `issue.type`, `issue.expected`,
  `issue.received`, `issue.minimum`, `issue.validation` to pick the right
  message key in `messages.codes.*`.
- For `ZodIssueCode.custom` whose `issue.message` starts with
  `"validation."`, treats the message as a dot-path key, looks it up in
  `messages.custom.*`, and returns the resolved string. If the key is
  missing, logs a warn (via `console.warn` with a stable prefix
  `[i18n-validation] missing key:`) and returns the raw key so the gap is
  visible in QA.
- For `ZodIssueCode.custom` whose message does **not** start with
  `"validation."`, returns the raw message (back-compat for any caller that
  legitimately wants a literal English string, e.g. transient debug).

**`runtime.ts`** — `AsyncLocalStorage<Locale>` instance + thin helpers.
- `runWithLocale(locale, fn)` — wraps a function in ALS scope.
- `currentLocale(): Locale` — reads from ALS, falls back to
  `DEFAULT_LOCALE` if no scope is active (e.g. background jobs, cron).

**`setup.ts`** — `setGlobalLocaleErrorMap()`:
- Builds a single ZodErrorMap that, at issue-time, reads `currentLocale()`
  and dispatches to a per-locale `createErrorMap` (memoised one per
  locale on first use).
- Calls `z.setErrorMap(thatErrorMap)`.
- Idempotent — calling twice is a no-op (guard with module-local flag).

### Server wiring (apps/api)

```ts
// apps/api/src/server.ts (near startup)
import { setGlobalLocaleErrorMap } from '@caliber/i18n-validation'
setGlobalLocaleErrorMap()
```

```ts
// apps/api/src/trpc/context.ts (or wherever createContext lives)
import { runWithLocale, resolveLocale } from '@caliber/i18n-validation'

export function createContext({ req }: CreateFastifyContextOptions) {
  const cookie = parseCookie(req.headers.cookie, 'NEXT_LOCALE')
  const acceptLanguage = req.headers['accept-language'] ?? null
  const locale = resolveLocale({ cookie, acceptLanguage })
  // attach to ctx for any handler that wants explicit access,
  // and run the whole tRPC handler inside ALS scope
  return { locale, /* …rest… */ }
}

// At the request boundary (fastify-trpc adapter), wrap:
//   runWithLocale(ctx.locale, () => handle(req))
```

The wrap point is the `fastify-trpc` plugin's onRequest/handler — exact
hookup decided in the implementation plan.

### Client wiring (apps/web)

```tsx
// apps/web/src/app/layout.tsx
<NextIntlClientProvider locale={locale} messages={messages}>
  <ValidationErrorMapProvider>
    {children}
  </ValidationErrorMapProvider>
</NextIntlClientProvider>
```

```tsx
// apps/web/src/lib/i18n/ValidationErrorMapProvider.tsx
'use client'
import { useEffect } from 'react'
import { useLocale } from 'next-intl'
import { z } from 'zod'
import { createErrorMap, loadValidationMessages } from '@caliber/i18n-validation'

export function ValidationErrorMapProvider({ children }) {
  const locale = useLocale()
  useEffect(() => {
    let cancelled = false
    void loadValidationMessages(locale).then((messages) => {
      if (!cancelled) z.setErrorMap(createErrorMap(messages))
    })
    return () => { cancelled = true }
  }, [locale])
  return <>{children}</>
}
```

react-hook-form's `zodResolver` calls `schema.safeParse(values)` inside
the React render scope — it picks up whatever `z.setErrorMap` was last
called with. No per-form change needed.

Locale module reuse: `apps/web/src/i18n/locales.ts` becomes a thin
re-export of `@caliber/i18n-validation` (keep the file path for existing
imports). Same for the `pickFromAcceptLanguage` half of
`apps/web/src/i18n/request.ts`.

### Data flow diagrams

**Server-side (form submit → tRPC mutation fails Zod parse):**
```
browser POST /trpc/accounts.create
  Cookie: NEXT_LOCALE=zh-TW
  Accept-Language: zh-TW,zh;q=0.9
        |
        v
  Next.js rewrite → apps/api (Fastify)
        |
        v
  createContext: resolveLocale → "zh-TW"
        |
        v
  runWithLocale("zh-TW", () => handle(req))
        |
        v
  router.accounts.create.input(zodSchema).parse(input)
        |
        v   (parse fails)
  z.setErrorMap callback reads currentLocale() → "zh-TW"
        |
        v
  loads messages/zh-TW.json (cached)
        |
        v
  formats ZodIssue → "名稱為必填"
        |
        v
  tRPC wraps in TRPCError { message: "名稱為必填", cause: zodError }
        |
        v
  client onError: toast.error(error.message) → "名稱為必填"
```

**Client-side (form submit, fails before reaching server):**
```
user types empty name, blurs
        |
        v
  react-hook-form zodResolver → schema.safeParse({...})
        |
        v
  parse fails; Zod calls global errorMap (set by ValidationErrorMapProvider for current locale)
        |
        v
  errorMap returns "名稱為必填"
        |
        v
  rhf surfaces errors.name.message = "名稱為必填"
        |
        v
  <p className="error">{errors.name?.message}</p>
```

## Message Catalogue Shape

`packages/i18n-validation/messages/en.json` (illustrative — full set
finalised in PR A):

```json
{
  "validation": {
    "codes": {
      "invalid_type": "Expected {expected}, received {received}",
      "too_small": {
        "string": {
          "inclusive": "Must contain at least {minimum} character(s)",
          "exclusive": "Must contain more than {minimum} character(s)"
        },
        "number": {
          "inclusive": "Must be greater than or equal to {minimum}",
          "exclusive": "Must be greater than {minimum}"
        },
        "array": {
          "inclusive": "Must contain at least {minimum} item(s)",
          "exclusive": "Must contain more than {minimum} item(s)"
        },
        "date": {
          "inclusive": "Date must be on or after {minimum}",
          "exclusive": "Date must be after {minimum}"
        }
      },
      "too_big": { "...": "same shape as too_small; full content filled during PR A" },
      "invalid_string": {
        "email": "Invalid email address",
        "url": "Invalid URL",
        "uuid": "Invalid UUID",
        "regex": "Invalid format",
        "datetime": "Invalid date-time",
        "cuid": "Invalid CUID",
        "default": "Invalid string"
      },
      "invalid_enum_value": "Expected one of {options}, received '{received}'",
      "invalid_literal": "Expected {expected}",
      "invalid_union": "Invalid input",
      "invalid_union_discriminator": "Invalid discriminator value. Expected one of {options}",
      "unrecognized_keys": "Unrecognised key(s) in object: {keys}",
      "not_multiple_of": "Must be a multiple of {multipleOf}",
      "not_finite": "Number must be finite",
      "invalid_date": "Invalid date",
      "custom": "Invalid input"
    },
    "custom": {
      "accounts": {
        "nameRequired": "Name is required",
        "credentialsRequired": "Credentials are required",
        "credentialsTooLong": "Credentials are too long",
        "teamRequired": "Pick a team",
        "oauthJsonInvalid": "OAuth credentials must be valid JSON"
      },
      "accountGroups": { "...": "populated during PR B sweep from audit-script output" },
      "evaluator": { "...": "populated during PR B sweep from audit-script output" }
    }
  }
}
```

zh-TW counterpart:

```json
{
  "validation": {
    "codes": {
      "invalid_type": "應為 {expected}，但收到 {received}",
      "too_small": {
        "string": {
          "inclusive": "至少需 {minimum} 個字元",
          "exclusive": "需多於 {minimum} 個字元"
        },
        "number": {
          "inclusive": "需大於或等於 {minimum}",
          "exclusive": "需大於 {minimum}"
        }
      },
      "invalid_string": {
        "email": "請輸入有效的電子郵件地址",
        "url": "請輸入有效的網址",
        "uuid": "UUID 格式不正確",
        "regex": "格式不正確",
        "datetime": "日期時間格式不正確"
      },
      "invalid_enum_value": "應為 {options} 之一，但收到「{received}」"
    },
    "custom": {
      "accounts": {
        "nameRequired": "名稱為必填",
        "credentialsRequired": "憑證為必填",
        "teamRequired": "請選擇團隊",
        "oauthJsonInvalid": "OAuth 憑證必須為有效的 JSON"
      }
    }
  }
}
```

zh-TW conventions in use:
- 「必填」 (not 「必須提供」)
- 「請輸入有效的...」prefix for format errors
- 「應為 X，但收到 Y」for type-mismatch
- Full-width punctuation throughout
- No 「您」

## Error Handling

- **Missing ALS context** (background job, cron): `currentLocale()` returns
  `DEFAULT_LOCALE`. Logged once-per-process with a tagged warn.
- **Missing translation key**: `[i18n-validation] missing key: <path>`
  warn + returns the raw key as the message (so QA sees the gap).
- **Unknown locale value** (cookie tampered with): `isLocale()` rejects,
  falls back to `DEFAULT_LOCALE`.
- **Concurrent locale switch on client**: `useEffect` cleanup cancels
  superseded message loads; latest locale wins.
- **HKDF cipher errors, network failures, etc.**: unrelated. errorMap only
  fires on Zod parse failures.

## Testing Strategy

**Package level (`packages/i18n-validation/tests/`)**

- `errorMap.test.ts`:
  - For each Zod issue code that the package handles, assert
    `createErrorMap(messages)({ code, …issue-fields }).message ===
    expectedString` per locale.
  - Table-driven across all 5 locales × ~15 issue variants.
- `messages.test.ts`:
  - Snapshot of `en.json` key paths. For each other locale, assert key set
    is identical (set-diff with diagnostic on missing/extra keys).
- `runtime.test.ts`:
  - `runWithLocale("zh-TW", () => currentLocale())` === "zh-TW".
  - Nested scopes work (inner overrides outer).
  - Outside any scope, `currentLocale()` returns DEFAULT_LOCALE.

**apps/api**

- Integration: spin tRPC test caller with `Accept-Language: zh-TW` header,
  call `accounts.create` with empty name, assert `error.message === "名稱為
  必填"`.
- Regression: existing tRPC tests still pass.

**apps/web**

- Unit: render a form with `zodResolver`, set locale to `zh-TW` via the
  Provider, submit empty → assert `errors.name?.message` is the 繁中 string.
- Smoke (post-deploy, PR B): manual checklist — 1 form per locale, run
  through happy path + each validation error path, screenshots in PR body.

## PR Breakdown

### PR A — Foundation

**Title**: `feat(i18n): server-aware Zod error map with 5-locale defaults`

**Scope**:
1. Create `packages/i18n-validation/` package per the structure above.
2. Move `LOCALES/Locale/DEFAULT_LOCALE/LOCALE_COOKIE/isLocale/pickFromAcceptLanguage`
   into the new package; replace `apps/web/src/i18n/locales.ts` and the
   relevant chunk of `request.ts` with re-exports/thin adapters.
3. `apps/api` server bootstrap calls `setGlobalLocaleErrorMap()`.
4. `apps/api/src/trpc/context.ts` resolves locale + wraps handlers in
   `runWithLocale`.
5. `apps/web/src/app/layout.tsx` wraps children with
   `<ValidationErrorMapProvider>`.
6. `validation.codes.*` 5-locale catalogues completed.
7. Tests: errorMap unit, messages parity snapshot, runtime ALS, tRPC
   integration.
8. PR body explicitly documents the transitional state: inline custom
   messages still surface in English — PR B follows up.

**Out of scope for PR A**: any change to `.min(1, "X")`-style schemas in
the codebase.

**Verification**:
- `pnpm test` green across affected workspaces.
- Smoke: switch locale to zh-TW in the web UI, trigger a form-level
  default-code error (e.g. submit with an invalid email format) → message
  in 繁中.
- Curl `apps/api` directly with `Accept-Language: ja` on an endpoint with
  a UUID input, send malformed → response message in 日本語.

### PR B — Sweep + polish

**Title**: `feat(i18n): translate all inline Zod custom messages`

**Scope**:
1. Audit script (one-shot helper, may live under `scripts/`): walk
   `apps/{api,web}/src/**/*.{ts,tsx}` AST, find:
   - `z.<…>(args, "literal string")` — second-arg literal
   - `z.<…>(args, { message: "literal string" })` — options-object literal
   - `.refine(predicate, { message: "literal string", … })`
   - `.superRefine(...)` ctx.addIssue with literal message
   Emit a report (TSV: file, line, current message, suggested key).
2. For each occurrence, replace literal with key form
   (`{ message: "validation.custom.<area>.<name>" }`); add the key to all
   5 locale JSON files.
3. Update `errorMap.ts` to handle `ZodIssueCode.custom` with
   `"validation."`-prefixed message as a lookup (designed in PR A; code
   path exercised in PR B once keys exist).
4. Add unit tests: each new custom key resolves in every locale.
5. zh-TW polish pass by the author; remaining 4 locales get LLM-grade
   translation in this PR with a follow-up issue filed for native review
   (mirrors the existing convention in `project_state.md`).
6. Smoke: PR-body checklist with screenshots of the four most-used forms
   (Account create, Account-group create, Evaluator settings, Org member
   invite) in each of the 5 locales.

**Verification**:
- Audit script reports zero remaining literal validation messages in
  `apps/{api,web}/src`.
- Manual smoke per the PR-body checklist.
- `pnpm test` green.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| AsyncLocalStorage not preserved across an await boundary in tRPC handler chain | tRPC handlers are async functions inside `runWithLocale` — Node's ALS preserves across awaits. Verified with integration test that includes an `await` inside the resolver. |
| Client-side errorMap not set before first form render | Provider runs in `useEffect` post-mount. Initial render may see Zod's built-in English fallback for ~1 paint. Acceptable; alternative is SSR-side `z.setErrorMap` which complicates the next-intl boundary. If user feedback says it's visible, revisit with a synchronous setter that runs in `'use client'` module init. |
| Translation key drift between locales | Snapshot test `messages.test.ts` blocks merges where any locale has missing/extra keys. |
| Re-exports break existing `apps/web/src/i18n/*` imports | Use file-shape-preserving adapters (`apps/web/src/i18n/locales.ts` keeps named exports verbatim, just imports from the package). |
| Custom messages collision (two areas pick the same key) | Namespaced under `validation.custom.<area>.<name>`. Audit script flags duplicates. |
| Background queues (BullMQ jobs) running Zod parses with no ALS scope | `currentLocale()` falls back to `DEFAULT_LOCALE` (English). Acceptable for log-only paths. If a job's output is user-facing, that job should `runWithLocale(job.locale, ...)` explicitly. |

## Open Questions (deferred to implementation plan)

- Exact tRPC wrap point inside the fastify adapter (decided when reading
  `apps/api/src/server.ts` during PR A).
- Whether to publish `@caliber/i18n-validation` types under
  `packages/api-types` or keep them package-local.
- Whether the audit script in PR B is committed (`scripts/audit-zod-i18n.ts`)
  or stays one-shot in the PR description.

## Deliverables Summary

- New package `@caliber/i18n-validation` with locale resolution, error map,
  AsyncLocalStorage runtime, and 5 locale validation message catalogues.
- `apps/api` tRPC context + bootstrap changes.
- `apps/web` Provider + thin re-export adapter.
- Two PRs landed: foundation, then sweep.
- Native-review follow-up issue filed for `zh-CN/ja/ko` strings.
- Backlog item in `project_state.md` removed.
