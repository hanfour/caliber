# BYOK UI — Self-Service Upstreams Page + routing_policy Selector

**Date:** 2026-06-08
**Status:** Design (approved for spec) — pending writing-plans
**Depends on:** BYOK P1 (shipped v0.8.0) — the tRPC + gateway backend. This adds the **web UI** for it.

## Background

BYOK P1 (v0.8.0) shipped backend-only: tRPC mutations `accounts.registerOwn` / `listOwn` /
`updateOwn` / `deleteOwn` / `rotateOwn`, and `apiKeys.issueOwn` accepting a
`routingPolicy` (`pool` | `own` | `own_then_pool`). There is **no dashboard UI** — a user cannot
register their own upstream or issue an own-routing key by clicking. This project builds that UI so
a member can self-serve BYOK end-to-end.

The full backend already exists and is live-verified on deployed v0.8.0; this is purely an
`apps/web` change (plus i18n strings). No API/gateway/DB changes.

### Decisions captured during brainstorming
- **Scope:** both halves needed for end-to-end BYOK — (1) a "My Upstreams" management page, AND
  (2) a `routing_policy` selector on the member self-service api-key dialog (so a user can issue a
  key that actually routes to their registered upstream).
- **Page:** `/dashboard/upstreams`, titled "My Upstreams" (我的上游), in the left-nav **account**
  section alongside Profile / Devices.
- **routing_policy selector:** a 3-option `<select>`, default `pool`, with a one-line explanation
  per option. Added to the **member** `ApiKeyCreateDialog` only (not the admin AdminIssueDialog).
- **Page actions (v1):** full credential lifecycle — register, edit (rename / enable-disable /
  priority), rotate, delete.
- **Component structure:** Approach A — dedicated, single-responsibility components mirroring the
  existing `DeviceList` / `ApiKeyList` / `ApiKeyCreateDialog` patterns.
- **Credential types:** **api_key only** (matches the P1 backend; OAuth self-service is P2).

## Non-Goals
- OAuth self-service in the UI (P2).
- Credential health/expiry detail, probe-on-save, usage charts per upstream (P3) — the list shows
  only the backend's existing `status` (active / expired / disabled).
- Admin issuing an own-policy key for another user (edge case; AdminIssueDialog keeps group binding).
- Any backend (tRPC/gateway/DB) change — all backend is already shipped in v0.8.0.

## Architecture Overview

Three cohesive changes, all in `apps/web`:
1. **Page + nav** — new `/dashboard/upstreams` route + a sidebar entry.
2. **My Upstreams components** — `UpstreamOwnList` + four dialogs (register / edit / rotate /
   delete-via-useConfirm), each calling the matching `accounts.*Own` tRPC procedure.
3. **routing_policy selector** — extend the member `ApiKeyCreateDialog` to pass `routingPolicy` to
   `apiKeys.issueOwn`, plus new i18n strings.

All patterns mirror existing code (see "Patterns to mirror" refs). tRPC `accounts.*` is already on
the web `AppRouter` type (`@caliber/api-types`) — no client regen needed.

## 1. Page + Navigation

### 1.1 Route
`apps/web/src/app/dashboard/upstreams/page.tsx` — a `"use client"` component mirroring
`app/dashboard/devices/page.tsx`: a page heading (`t("upstreams.pageTitle")` / `pageSubtitle`)
followed by `<UpstreamOwnList />`. Auth is already enforced by `app/dashboard/layout.tsx`
(server-side `auth()` redirect); no extra guard needed.

### 1.2 Sidebar entry
In `apps/web/src/components/nav/Sidebar.tsx`:
- Add `'upstreams'` to the `NavItemKey` union (~line 30).
- Add to the **account** section (~line 75-82, beside Profile/Devices):
  `{ href: '/dashboard/upstreams', labelKey: 'upstreams', icon: Key /* lucide */, visible: (p) => p.hasOrg }`.

## 2. My Upstreams Components

All under `apps/web/src/components/upstreams/`.

### 2.1 `UpstreamOwnList.tsx` (mirror `DeviceList.tsx`)
- `const { data, isLoading, error } = trpc.accounts.listOwn.useQuery()`; row type
  `inferRouterOutputs<AppRouter>["accounts"]["listOwn"][number]`.
- Loading / error / empty states identical in shape to `DeviceList`.
- Table columns: **name**, **platform**, **type** (render the row's actual `type` — api_key today,
  but don't hard-assume it, so a future P2 OAuth-owned row displays correctly), **status** (active /
  expired / disabled — from the row's `status` + `schedulable`), **priority**, **created / last used**.
- Row actions: **Edit** (opens `UpstreamEditDialog`), **Rotate** (opens `UpstreamRotateDialog`),
  **Delete**.
- Header button **"Register credential"** opens `UpstreamRegisterDialog`.
- Delete: `const confirm = useConfirm()` (`@/components/ui/confirm-dialog`) →
  `await confirm({ description: t("confirmDelete", { name }), destructive: true })` →
  `trpc.accounts.deleteOwn.useMutation({ onSuccess: invalidate listOwn + toast, onError: code === "FORBIDDEN" ? insufficientPermission : message })`.

### 2.2 `UpstreamRegisterDialog.tsx` (mirror `AccountCreateForm.tsx`, simplified)
- `react-hook-form` + `useTranslatedZodResolver`. Schema:
  `{ name: z.string().min(1,"validation.custom.shared.nameRequired").max(255), platform: z.enum(["anthropic","openai"]), credentials: z.string().min(1).max(100_000) }`.
- Fields: name `<Input>`; platform native `<select>` (anthropic / openai) with the existing
  platform hints; credentials native `<textarea rows={6}>` with placeholder switching by platform
  (`sk-ant-…` / `sk-…`). **No `type` field** — fixed `api_key` at the mutation call.
- Submit: `trpc.accounts.registerOwn.useMutation({ ... })` with `type: "api_key"` injected.
  On success: toast + `utils.accounts.listOwn.invalidate()` + close. **No one-time-reveal stage** —
  `registerOwn` returns the account row, not a secret (unlike api-keys). Reset form on close
  (`useEffect` on `open`).

### 2.3 `UpstreamEditDialog.tsx`
- Metadata-only edit for an existing own upstream. Fields: name `<Input>`,
  schedulable enable/disable (toggle/checkbox), priority `<input type=number min=0 max=1000>`.
  Prefilled from the row. **No credentials field.**
- Submit: `trpc.accounts.updateOwn.useMutation({ ... })` → invalidate + toast.

### 2.4 `UpstreamRotateDialog.tsx`
- Single credentials `<textarea>` (re-enter), with an amber warning row "this replaces the stored
  credential". Submit: `trpc.accounts.rotateOwn.useMutation({ ... })` → invalidate + toast.
  **No reveal.** Reset on close.

## 3. routing_policy Selector on the member api-key dialog

In `apps/web/src/components/apiKeys/ApiKeyCreateDialog.tsx` (the **member self-issue** dialog,
which calls `apiKeys.issueOwn` and has **no** group selector):
- Add `routingPolicy: z.enum(["pool","own","own_then_pool"]).default("pool")` to the form schema.
- Render a native `<select>` (default `pool`) with a one-line helper per option:
  - **pool** — "Use the workspace's shared upstreams" (default).
  - **own** — "Only use upstreams I've registered myself."
  - **own_then_pool** — "Prefer mine; fall back to the shared pool if I have none."
- Pass `routingPolicy` into `issueOwn.mutateAsync({ name, routingPolicy })`.
- No mutual-exclusion concern: this dialog has no `groupId` (the DB CHECK is satisfied trivially).
- The admin `AdminIssueDialog` is unchanged (keeps its group selector; pool routing).

## 4. i18n

- New `upstreams` namespace in all 5 catalogs (`apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json`):
  page title/subtitle, table headers, register/edit/rotate dialog titles + field labels + hints,
  confirm/delete prompts, toasts, error strings.
- Add routing_policy strings under `memberApiKeys.createDialog.*` (5 catalogs): the field label +
  the three option labels + their one-line explanations.
- Add `nav.items.upstreams` (5 catalogs).
- zh-CN / ja / ko strings are LLM-grade pending native review — consistent with the existing
  catalogue and the open #134 gate; not a blocker for shipping the en/zh-TW operator-facing UI.

## 5. Error Handling

Mirror the established member-component idiom: every mutation's `onError` reads
`(e.data as { code?: string }).code` → `FORBIDDEN` shows `common.insufficientPermission`, else
`e.message` via `toast.error`. Form validation errors render inline under each field
(`errors.<field>.message`, translated by `useTranslatedZodResolver`). The gateway-side
`409 no_own_upstream` is not surfaced here (it's a request-time runtime error on the data plane, not
a dashboard action); a "you have no upstream for this platform yet" empty-state hint on the list is
sufficient guidance.

## 6. Testing

- First detect whether `apps/web` has a component-test setup (vitest + @testing-library/react).
  Check `apps/web/package.json` test script + any existing `*.test.tsx`.
- **If a web test harness exists:** add focused tests — `UpstreamOwnList` (renders rows from a
  mocked `listOwn`, empty state), `UpstreamRegisterDialog` (submits with `type:"api_key"` injected,
  blocks empty credential), and the `ApiKeyCreateDialog` routing_policy selector (defaults `pool`,
  passes the chosen value to `issueOwn`). Mock the tRPC hooks as existing web tests do.
- **If no web component-test harness exists:** do NOT stand one up for this feature. Rely on
  `tsc --noEmit` (typecheck) + a manual/browser smoke against the deployed app (the established
  verification path for this web app). State this explicitly in the plan.

## 7. Patterns to mirror (file refs)

- Page: `apps/web/src/app/dashboard/devices/page.tsx`
- Nav: `apps/web/src/components/nav/Sidebar.tsx` (NavItemKey + account section)
- List + delete-confirm: `apps/web/src/components/devices/DeviceList.tsx`,
  `apps/web/src/components/apiKeys/ApiKeyList.tsx`
- Confirm dialog: `useConfirm` from `apps/web/src/components/ui/confirm-dialog.tsx`
- Form + reveal/dialog: `apps/web/src/components/apiKeys/ApiKeyCreateDialog.tsx`,
  `apps/web/src/components/accounts/AccountCreateForm.tsx`
- tRPC client: `apps/web/src/lib/trpc/client.ts`; `inferRouterOutputs<AppRouter>` from
  `@caliber/api-types`
- Form validation: `apps/web/src/lib/i18n/useTranslatedZodResolver.ts`
- UI primitives: `apps/web/src/components/ui/` (Button, Input, Label, Dialog, Card, Badge; native
  `<select>` / `<textarea>`)
- i18n: `useTranslations("<ns>")` from `next-intl`; catalogs `apps/web/messages/*.json`

## Open Questions / Risks
- **Native `<select>` vs a styled component:** the codebase uses native `<select>` (no Select
  primitive). Follow that. Minor visual inconsistency is acceptable and matches `AccountCreateForm`.
- **`listOwn` returns no credential material** (creds live in `credential_vault`) — safe to render
  the rows directly, same as the admin accounts list.
- **OAuth-owned rows:** P1 registerOwn only creates api_key rows, but a future P2 OAuth row would
  appear in `listOwn`; the list's `type` column should render whatever `type` the row carries (don't
  hard-assume api_key in display), even though the register form only creates api_key.
