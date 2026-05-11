# HKDF v2 Cipher Migration

**Date:** 2026-05-11
**Closes:** GitHub issue #121
**Risk class:** High — touches encrypted persistence (credential vault + captured request/response bodies). Mistakes corrupt operator data.

## Goal

Rotate the HKDF `info` strings for the gateway's two ciphers from the original `aide` brand to the `caliber` brand without losing access to existing encrypted data:

- `BODY_INFO`: `aide-gateway-body-v1` → `caliber-gateway-body-v2`
- `CREDENTIAL_INFO`: `aide-gateway-credential-v1` → `caliber-gateway-credential-v2`

The migration is structured around two constraints the operator chose:

1. **Zero downtime.** Gateway and api never stop. New writes use v2; reads dispatch on a per-row `cipher_version`.
2. **Force one OAuth refresh sweep.** Every `oauth` upstream account gets its `credential_vault` row rewritten as v2 by invoking the existing refresh flow. `api_key` upstream accounts get a separate decrypt-v1 → encrypt-v2 → write-back sweep. Captured bodies migrate by natural 90-day retention drain — no body migration sweep.

## Non-goals

- Not rotating the master `CREDENTIAL_ENCRYPTION_KEY`. Only the HKDF `info` string changes.
- Not changing the AES-GCM envelope shape (`{nonce, ciphertext, authTag}`).
- Not migrating `.claude/plans/*` or other historical docs that mention v1 by name.
- Not dropping the v1 decrypt code path in this PR — that lives in a follow-up issue gated on 90-day body drain.

## Architecture

### Schema change

Add a `cipher_version SMALLINT NOT NULL DEFAULT 1` column to both tables that hold sealed payloads. Default 1 means every pre-existing row is unambiguously v1 without a backfill UPDATE.

```sql
ALTER TABLE credential_vault
  ADD COLUMN cipher_version SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE request_bodies
  ADD COLUMN cipher_version SMALLINT NOT NULL DEFAULT 1;
```

Drizzle schema files (`packages/db/src/schema/credentialVault.ts`, `requestBodies.ts`) get a matching `cipherVersion: smallint("cipher_version").notNull().default(1)` field.

### Cipher module API (`packages/gateway-core/src/crypto/`)

Both `bodyCipher.ts` and `credentialCipher.ts` follow the same shape. Using `bodyCipher` as the canonical example:

```typescript
import { encryptAesGcm, decryptAesGcm, type Sealed } from './aesGcmHkdf.js'

export type SealedBody = Sealed
export type BodyCipherVersion = 1 | 2
export const CURRENT_BODY_CIPHER_VERSION: BodyCipherVersion = 2

const BODY_INFO_V1 = Buffer.from('aide-gateway-body-v1', 'utf8')
const BODY_INFO_V2 = Buffer.from('caliber-gateway-body-v2', 'utf8')

function bodyInfo(version: BodyCipherVersion): Buffer {
  return version === 2 ? BODY_INFO_V2 : BODY_INFO_V1
}

interface EncryptBodyInput {
  masterKeyHex: string
  requestId: string
  plaintext: string
}

interface DecryptBodyInput {
  masterKeyHex: string
  requestId: string
  sealed: SealedBody
  version: BodyCipherVersion
}

export function encryptBodyRaw(input: EncryptBodyInput): SealedBody & { version: 2 } {
  const sealed = encryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: BODY_INFO_V2,
    salt: input.requestId,
    plaintext: input.plaintext,
  })
  return { ...sealed, version: 2 }
}

export function decryptBodyRaw(input: DecryptBodyInput): string {
  return decryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: bodyInfo(input.version),
    salt: input.requestId,
    sealed: input.sealed,
  })
}
```

`credentialCipher.ts` mirrors this with `CREDENTIAL_INFO_V1`, `CREDENTIAL_INFO_V2`, `CredentialCipherVersion`, etc.

### Caller updates

Six call sites adapt to the new API:

| File | Path | Change |
|---|---|---|
| `apps/gateway/src/capture/encrypt.ts` | wrapper | `encryptBody` returns version; `decryptBody` accepts `version` parameter |
| `apps/gateway/src/workers/bodyCapturePersist.ts` | 4 encrypt calls | persist `cipher_version: 2` into `request_bodies` insert |
| `apps/gateway/src/workers/evaluator/runRuleBased.ts` | decrypt body | read `row.cipherVersion` from DB, pass to `decryptBody` |
| `apps/gateway/src/runtime/resolveCredential.ts` | hot path | read `vaultRow.cipherVersion`, pass to `decryptCredential` |
| `apps/gateway/src/runtime/oauthRefresh.ts` | encrypt + decrypt | encrypt writes v2 + `cipher_version=2`; decrypt reads `cipher_version` |
| `apps/api/src/trpc/routers/accounts.ts` | 3 encrypt calls | all admin mutations write `cipher_version: 2` into vault row |

The interface change is additive: callers pass one extra parameter on decrypt, store one extra column on encrypt. No behavior change for already-encrypted rows.

### Rotation script (`apps/gateway/scripts/rotate-credentials-v2.ts`)

Standalone tsx script — **not** a worker, **not** a cron, **not** an admin tRPC mutation. Manual ops action with two modes:

```bash
# Default: dry-run (read-only, verifies round-trip without writing)
pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts

# Apply: writes new v2 rows
pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts --apply
```

**Dry-run behavior:**

1. `SELECT id, type FROM upstream_accounts WHERE deleted_at IS NULL`.
2. For each account, `SELECT cipher_version, nonce, ciphertext, auth_tag FROM credential_vault WHERE account_id = ?`.
3. If `cipher_version === 2` → log `[DRY] skip already-v2 account <id>`.
4. If `type === 'api_key'`:
   - `decryptCredential({ ..., version: 1 })` to recover plaintext.
   - `encryptCredential({ ..., })` to produce v2 sealed.
   - `decryptCredential({ ..., version: 2 })` on the new sealed to verify the round-trip yields the original plaintext.
   - Log `[DRY] would rotate api_key account <id>: round-trip OK`.
   - On any failure: log `[DRY] FAIL api_key account <id>: <reason>` and continue.
   - **Do not write to DB.**
5. If `type === 'oauth'`:
   - **Do not call `refreshOAuthCredential()`** — that would burn a refresh_token round-trip against Anthropic.
   - Just log `[DRY] would force refresh oauth account <id>`.
6. Print summary: `{ apply: false, candidates: N, already_v2: N, api_key_ok: N, api_key_fail: N, oauth_to_refresh: N }`.

Exit code 0 if all candidate api_key rows round-trip successfully; non-zero if any decrypt fails (signals corrupt vault row).

**`--apply` behavior:**

Same scan, but:

- `api_key`: decrypt-v1 → encrypt-v2 → `UPDATE credential_vault SET nonce=?, ciphertext=?, auth_tag=?, cipher_version=2, rotated_at=NOW() WHERE account_id=?`. Each account is its own transaction.
- `oauth`: call existing `refreshOAuthCredential(account)` (in `apps/gateway/src/runtime/oauthRefresh.ts`). The refresh path itself encrypts the new credential as v2 (because encrypt always writes v2) and writes `cipher_version=2`. Failures (network, Anthropic 4xx) log + continue; the account stays on v1 and decrypt path still works.

Summary on `--apply`: `{ apply: true, migrated_api_key: N, refreshed_oauth: N, oauth_failed: N, skipped_v2: N, total: N }`.

**Idempotent.** Re-run is safe: `cipher_version === 2` rows are skipped on every pass.

**No body sweep.** `request_bodies` rows are not touched by this script. They remain v1 until their 90-day `retention_until` expires and the existing body-purge cron deletes them. New body writes are v2 from PR merge onward.

### Storage layout reminder

Both target tables already have the AES-GCM tuple as bytea columns. The change is one new smallint column:

```
credential_vault:
  id, account_id, nonce, ciphertext, auth_tag, oauth_expires_at,
  created_at, rotated_at, cipher_version (new)

request_bodies:
  request_id, org_id, request_body_sealed, response_body_sealed,
  thinking_body_sealed, attempt_errors_sealed, request_params,
  stop_reason, client_user_agent, client_session_id, attachments_meta,
  cache_control_markers, tool_result_truncated, body_truncated,
  captured_at, retention_until, cipher_version (new)
```

`cipher_version` applies uniformly to all sealed columns within a `request_bodies` row — the four sealed columns share the same version because they are written together by `bodyCapturePersist.ts`.

## Test plan

**Unit tests (cipher module):**

- `bodyCipher.test.ts` / `credentialCipher.test.ts`:
  - Encrypt → result includes `version: 2`.
  - Decrypt with `version: 2` of a freshly-encrypted sealed → original plaintext.
  - Decrypt with `version: 1` of a pre-recorded v1 fixture → original plaintext.
  - Decrypt with `version: 2` of a v1 ciphertext → throws (GCM auth tag fail).
  - Decrypt with `version: 1` of a v2 ciphertext → throws.

Use deterministic fixtures: fixed `masterKeyHex`, fixed salt, fixed plaintext, pre-recorded v1 sealed bytes in the test file. This protects against future accidental changes to the v1 HKDF info string.

**Unit tests (caller dispatch):**

- `apps/gateway/tests/runtime/resolveCredential.dispatch.test.ts`: mocked vault row with `cipherVersion: 1` decrypts correctly; same with `cipherVersion: 2`.
- `apps/gateway/tests/workers/bodyCapturePersist.cipher.test.ts`: encrypt writes `cipher_version: 2` into the row.

**Unit tests (rotation script):**

- `apps/gateway/scripts/__tests__/rotate-credentials-v2.test.ts`:
  - Dry-run on a v1 api_key row: logs "round-trip OK", DB row unchanged.
  - Dry-run on a v1 oauth row: logs "would force refresh", refresh function NOT called.
  - `--apply` on a v1 api_key row: row becomes v2, plaintext preserved (verifiable via decrypt-v2).
  - `--apply` on a v1 oauth row: refresh function called.
  - Idempotency: row already v2 → skipped on both dry-run and apply.
  - Failure isolation: one oauth refresh failure does not abort the batch; remaining accounts process.
  - Summary counts match.

**Integration test (existing extended):**

- `apps/api/tests/integration/trpc/accounts.test.ts`: any test that calls `accounts.create` / `accounts.update` / `accounts.rotate` now also asserts the vault row was written with `cipher_version: 2`.

**No new E2E tests.** The change is below the API surface — existing E2E tests still pass (decrypt of newly-encrypted v2 row is transparent to consumers).

## Verification (SQL)

After PR merge but before running the rotation script:

```sql
-- All existing rows still v1
SELECT cipher_version, COUNT(*)
FROM credential_vault
GROUP BY cipher_version;
-- Expected: (1, N) only

-- New body writes already v2
SELECT cipher_version, COUNT(*)
FROM request_bodies
WHERE captured_at >= now() - interval '1 hour'
GROUP BY cipher_version;
-- Expected: (2, N) for recent inserts
```

After `--apply`:

```sql
SELECT cipher_version, COUNT(*)
FROM credential_vault
GROUP BY cipher_version;
-- Expected: (2, N) — no v1 rows remain (or only oauth-refresh-failed rows)

-- Bodies still mixed during the 90-day drain
SELECT cipher_version, COUNT(*)
FROM request_bodies
GROUP BY cipher_version;
-- Expected: (1, N1), (2, N2), N1 decaying toward zero over 90 days
```

## Rollout

| Stage | Action | Verification |
|---|---|---|
| 0 | Dev: branch + tests pass | `pnpm test` green |
| 1 | Merge PR + deploy gateway/api | Smoke `/v1/messages` request succeeds; logs show no decrypt failure |
| 2 | Smoke 30 min: observe `gw_oauth_refresh_dead_total`, decrypt error logs | No regressions |
| 3 | Operator runs `scripts/rotate-credentials-v2.ts` (dry-run) | Summary clean; round-trip OK on every candidate |
| 4 | Operator runs `scripts/rotate-credentials-v2.ts --apply` | SQL: `credential_vault` cipher_version = 2 for all (or only failed oauth retries left) |
| 5 | (Optional) Retry failed oauth accounts | All accounts v2 |
| 6 | T+90 days: body retention drain check | `request_bodies` cipher_version = 2 only |
| 7 | Follow-up issue: drop v1 paths + column | Phase 4b cleanup PR |

## Rollback

**Before `--apply`:** safe. Code revert + redeploy. New v2-encrypted rows during the deployed window: bodies are append-only and disposable; the few OAuth credentials written by `oauthRefresh` after deploy and before revert would need one more refresh under v1 code to recover — `refreshOAuthCredential` re-runs cleanly under either code version.

**After `--apply`:** point of no return for credentials. v1 vault rows have been overwritten with v2 ciphertext; reverting the code path means existing rows cannot decrypt. **Mitigation:** dry-run first, verify round-trip on every account, only then `--apply`.

**Master key:** untouched. No master key rotation in this PR — that is a separate operation with its own design.

## Follow-up issue (filed when this PR opens)

Title: **Phase 4b cleanup: drop HKDF v1 cipher path + cipher_version column**

Blocked by: 90-day `request_bodies` retention drain from the merge date of this PR.

Acceptance:

- [ ] `SELECT cipher_version, COUNT(*) FROM request_bodies GROUP BY 1` returns only `2` (or zero v1 rows; manual deletion acceptable if a tail remains)
- [ ] Drop `BODY_INFO_V1`, `CREDENTIAL_INFO_V1`, `BodyCipherVersion`, `CredentialCipherVersion` from `packages/gateway-core/src/crypto/`
- [ ] Drop the `version` parameter from `decrypt*` signatures (single-version API)
- [ ] Drop the `cipher_version` column from `credential_vault` and `request_bodies` — optional, may keep as a prep for future v3
- [ ] Drop `apps/gateway/scripts/rotate-credentials-v2.ts`
- [ ] Remove the v1→v2 runbook section from operator docs

Labels: `rebrand`, `cleanup`, `blocked`.

## Operator runbook addendum (lives in PR body + monitoring docs)

After merging this PR, the operator must execute, in order:

1. Deploy the new gateway and api images.
2. Smoke-test one request through the gateway; confirm logs show no decrypt failure.
3. Run the rotation script in dry-run:
   ```bash
   pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts
   ```
   Confirm summary shows all api_key candidates round-trip OK and no decrypt failures.
4. Run with `--apply` to actually rotate:
   ```bash
   pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts --apply
   ```
5. Verify in SQL: `SELECT cipher_version, COUNT(*) FROM credential_vault GROUP BY 1` returns only `2`.
6. For any oauth accounts that failed refresh (logged in step 4): re-run the script; or re-onboard the account through the admin UI.
7. Record the merge date — Phase 4b cleanup (drop v1 paths) is gated on T+90 days from this date.

## Self-review

- **Placeholder scan:** none.
- **Internal consistency:** API signatures in Architecture section match the rotation script section and the test plan. The `version: 1 | 2` parameter shape is consistent everywhere. The `cipher_version` column is referenced uniformly across schema, queries, and script.
- **Scope check:** single PR, focused on cipher rotation + rotation script + tests. Cleanup is correctly deferred to follow-up issue.
- **Ambiguity check:** the dry-run / apply split is the deliberate safety boundary; both modes are spelled out so the executor cannot conflate them. `--apply` is opt-in; default is read-only. The body migration strategy is "natural drain only" with no script — this is restated in three places (architecture, verification SQL, follow-up issue).
- **High-risk check:** the rollback section explicitly names the point of no return (`--apply` execution) and the mitigation (dry-run first). The "before-`--apply`" rollback path is non-trivial — the spec describes it as recoverable but acknowledges a small window of v2-encrypted OAuth credentials that need one fresh refresh under reverted code. Honest about the cost.
