# HKDF v2 Cipher Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rotate HKDF `info` strings from `aide-gateway-{body,credential}-v1` to `caliber-gateway-{body,credential}-v2` with zero gateway downtime, using a `cipher_version` column to dispatch decrypt at read time, and a manual rotation script (`--dry-run` default, `--apply` to write) to backfill `credential_vault` rows. Closes #121.

**Architecture:** Add `cipher_version SMALLINT NOT NULL DEFAULT 1` column to `credential_vault` and `request_bodies`. Cipher module exposes `BODY_INFO_V1/V2` + `CREDENTIAL_INFO_V1/V2`; encrypt always writes v2 and reports `version: 2`; decrypt accepts `version: 1 | 2` and dispatches. Six callers updated to thread version through. Bodies migrate by natural 90-day retention drain — no body sweep. Standalone tsx rotation script handles vault rows.

**Tech Stack:** TypeScript (strict), Drizzle ORM, postgres, Node crypto (HKDF-SHA256 + AES-256-GCM), vitest, pnpm workspaces, BullMQ.

**Spec reference:** `docs/superpowers/specs/2026-05-11-hkdf-v2-migration-design.md` (committed earlier on this branch as `f503b03`).

**Branch state:** Already on `refactor/121-hkdf-v2-migration`, branched from `main` (commit `b475a28`). Spec doc is the only commit so far.

---

## Task 1: Schema migration (cipher_version columns)

**Files:**
- Create: `packages/db/drizzle/0012_cipher_version.sql`
- Create: `packages/db/drizzle/0012_down.sql`
- Modify: `packages/db/src/schema/credentialVault.ts`
- Modify: `packages/db/src/schema/requestBodies.ts`

- [ ] **Step 1: Write up migration SQL**

Create `packages/db/drizzle/0012_cipher_version.sql`:

```sql
-- HKDF v1 → v2 cipher rotation prep (#121).
--
-- Adds a per-row cipher_version marker so decrypt path can dispatch
-- between old (aide-gateway-*-v1) and new (caliber-gateway-*-v2) HKDF
-- info strings. DEFAULT 1 means every pre-existing row is unambiguously
-- v1 without a backfill UPDATE; postgres 11+ stores this as catalog
-- metadata only (no table rewrite, safe online).

ALTER TABLE "credential_vault"
  ADD COLUMN "cipher_version" SMALLINT NOT NULL DEFAULT 1;

--> statement-breakpoint

ALTER TABLE "request_bodies"
  ADD COLUMN "cipher_version" SMALLINT NOT NULL DEFAULT 1;
```

- [ ] **Step 2: Write down migration SQL**

Create `packages/db/drizzle/0012_down.sql`:

```sql
ALTER TABLE "credential_vault" DROP COLUMN "cipher_version";
--> statement-breakpoint
ALTER TABLE "request_bodies" DROP COLUMN "cipher_version";
```

- [ ] **Step 3: Update Drizzle schema for credential_vault**

Edit `packages/db/src/schema/credentialVault.ts`. Replace the column block to add `cipherVersion`:

```typescript
import {
  pgTable,
  uuid,
  customType,
  timestamp,
  smallint,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { upstreamAccounts } from "./accounts.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const credentialVault = pgTable(
  "credential_vault",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .unique()
      .references(() => upstreamAccounts.id, { onDelete: "cascade" }),
    nonce: bytea("nonce").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    authTag: bytea("auth_tag").notNull(),
    cipherVersion: smallint("cipher_version").notNull().default(1),
    oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => ({
    oauthExpiryIdx: index("credential_vault_oauth_expiry_idx")
      .on(t.oauthExpiresAt)
      .where(sql`${t.oauthExpiresAt} IS NOT NULL`),
  }),
);
```

- [ ] **Step 4: Update Drizzle schema for request_bodies**

Edit `packages/db/src/schema/requestBodies.ts`. Add `smallint` to imports and the `cipherVersion` field:

```typescript
import { pgTable, text, uuid, jsonb, customType, boolean, timestamp, smallint, index } from 'drizzle-orm/pg-core'
import { organizations } from './org.js'
import { usageLogs } from './usageLogs.js'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const requestBodies = pgTable('request_bodies', {
  requestId: text('request_id').primaryKey().references(() => usageLogs.requestId, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  requestBodySealed: bytea('request_body_sealed').notNull(),
  responseBodySealed: bytea('response_body_sealed').notNull(),
  thinkingBodySealed: bytea('thinking_body_sealed'),
  attemptErrorsSealed: bytea('attempt_errors_sealed'),
  cipherVersion: smallint('cipher_version').notNull().default(1),
  requestParams: jsonb('request_params'),
  stopReason: text('stop_reason'),
  clientUserAgent: text('client_user_agent'),
  clientSessionId: text('client_session_id'),
  attachmentsMeta: jsonb('attachments_meta'),
  cacheControlMarkers: jsonb('cache_control_markers'),
  toolResultTruncated: boolean('tool_result_truncated').notNull().default(false),
  bodyTruncated: boolean('body_truncated').notNull().default(false),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  retentionUntil: timestamp('retention_until', { withTimezone: true }).notNull(),
}, (t) => ({
  retentionIdx: index('request_bodies_retention_idx').on(t.retentionUntil),
  orgTimeIdx: index('request_bodies_org_time_idx').on(t.orgId, t.capturedAt),
}))
```

- [ ] **Step 5: Run migration against local dev DB**

Run:
```bash
pnpm --filter @caliber/db db:migrate
```

Expected: `Applying migration 0012_cipher_version.sql` then green. If `DATABASE_URL` not set, use `DATABASE_URL=postgresql://caliber:caliber_dev@localhost:5432/caliber pnpm --filter @caliber/db db:migrate`.

Verify in psql:
```bash
psql "$DATABASE_URL" -c "\d credential_vault" | grep cipher_version
psql "$DATABASE_URL" -c "\d request_bodies" | grep cipher_version
```
Expected: both show `cipher_version | smallint | not null | 1`.

- [ ] **Step 6: Typecheck**

Run:
```bash
pnpm --filter @caliber/db typecheck
```
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add packages/db/drizzle/0012_cipher_version.sql packages/db/drizzle/0012_down.sql packages/db/src/schema/credentialVault.ts packages/db/src/schema/requestBodies.ts
git commit -m "feat(db): add cipher_version column to credential_vault and request_bodies (#121)

Prep for HKDF v1 → v2 cipher rotation. Column defaults to 1 so all
existing rows are unambiguously v1 without backfill. New writes will
set cipher_version=2 once the cipher module change lands.

ADD COLUMN with constant DEFAULT is metadata-only on postgres 11+ —
no table rewrite, safe to run online."
```

---

## Task 2: Cipher module dual-version API

**Files:**
- Modify: `packages/gateway-core/src/crypto/bodyCipher.ts`
- Modify: `packages/gateway-core/src/crypto/credentialCipher.ts`

- [ ] **Step 1: Rewrite bodyCipher.ts**

Replace the entire file content with:

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

- [ ] **Step 2: Rewrite credentialCipher.ts**

Replace the entire file content with:

```typescript
import { encryptAesGcm, decryptAesGcm, type Sealed } from './aesGcmHkdf.js'

export type SealedCredential = Sealed
export type CredentialCipherVersion = 1 | 2
export const CURRENT_CREDENTIAL_CIPHER_VERSION: CredentialCipherVersion = 2

const CREDENTIAL_INFO_V1 = Buffer.from('aide-gateway-credential-v1', 'utf8')
const CREDENTIAL_INFO_V2 = Buffer.from('caliber-gateway-credential-v2', 'utf8')

function credentialInfo(version: CredentialCipherVersion): Buffer {
  return version === 2 ? CREDENTIAL_INFO_V2 : CREDENTIAL_INFO_V1
}

interface EncryptInput {
  masterKeyHex: string
  accountId: string
  plaintext: string
}

interface DecryptInput {
  masterKeyHex: string
  accountId: string
  sealed: SealedCredential
  version: CredentialCipherVersion
}

export function encryptCredential(input: EncryptInput): SealedCredential & { version: 2 } {
  const sealed = encryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: CREDENTIAL_INFO_V2,
    salt: input.accountId,
    plaintext: input.plaintext,
  })
  return { ...sealed, version: 2 }
}

export function decryptCredential(input: DecryptInput): string {
  return decryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: credentialInfo(input.version),
    salt: input.accountId,
    sealed: input.sealed,
  })
}
```

- [ ] **Step 3: Typecheck package**

Run:
```bash
pnpm --filter @caliber/gateway-core typecheck
```
Expected: typecheck FAILS — existing callers (test file `credentialCipher.test.ts`, plus consumers in `apps/`) don't pass `version` on decrypt. That's expected; Tasks 3–9 update them. Do NOT fix them in this task.

Note the failure list for your records. The cipher module itself compiles; only callers fail.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway-core/src/crypto/bodyCipher.ts packages/gateway-core/src/crypto/credentialCipher.ts
git commit -m "feat(gateway-core): dual-version HKDF info dispatch in body+credential ciphers (#121)

Adds BODY_INFO_V1/V2 and CREDENTIAL_INFO_V1/V2 constants. encrypt*
always writes v2 and returns {nonce, ciphertext, authTag, version: 2}.
decrypt* takes a version: 1 | 2 parameter and dispatches to the
matching HKDF info.

Compile of cipher module itself is clean; consumers (test file + 6
caller sites) break in this commit on purpose — wired up over the
next tasks."
```

---

## Task 3: Cipher module tests (dual-version + v1 fixtures)

**Files:**
- Modify: `packages/gateway-core/tests/credentialCipher.test.ts`
- Create: `packages/gateway-core/tests/bodyCipher.test.ts`

- [ ] **Step 1: Generate fixed v1 fixture bytes**

Before writing tests, generate deterministic v1 sealed bytes that future regressions can verify against. Run this once locally and copy the output strings into the test file (next step):

```bash
node -e '
const { hkdfSync, createCipheriv } = require("crypto");
const masterKeyHex = "a".repeat(64);
const accountId = "00000000-0000-0000-0000-000000000001";
const plaintext = JSON.stringify({ api_key: "sk-ant-test" });
const credInfoV1 = Buffer.from("aide-gateway-credential-v1", "utf8");
const key = Buffer.from(hkdfSync("sha256", Buffer.from(masterKeyHex, "hex"), Buffer.from(accountId, "utf8"), credInfoV1, 32));
const nonce = Buffer.alloc(12, 7);  // deterministic
const cipher = createCipheriv("aes-256-gcm", key, nonce);
const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
const tag = cipher.getAuthTag();
console.log("nonce", nonce.toString("hex"));
console.log("ciphertext", ct.toString("hex"));
console.log("authTag", tag.toString("hex"));
'
```

Copy the three hex strings printed. They are deterministic; you should get exactly:
- `nonce 070707070707070707070707`
- A `ciphertext` hex string (will be the same on every run)
- An `authTag` hex string

Repeat the same script for the body cipher fixture by changing `accountId` → `requestId` (e.g. `req-test-1`) and `credInfoV1` → `Buffer.from("aide-gateway-body-v1", "utf8")` and `plaintext` → `"hello body v1"`.

- [ ] **Step 2: Rewrite `tests/credentialCipher.test.ts`**

Replace existing content with:

```typescript
import { describe, it, expect } from "vitest";
import {
  encryptCredential,
  decryptCredential,
  CURRENT_CREDENTIAL_CIPHER_VERSION,
} from "../src/crypto/credentialCipher";
import { randomBytes } from "crypto";

const FIXED_MASTER = "a".repeat(64);
const FIXED_ACCOUNT = "00000000-0000-0000-0000-000000000001";
const FIXED_PLAINTEXT = JSON.stringify({ api_key: "sk-ant-test" });

// v1 fixture — pre-recorded ciphertext for the (FIXED_MASTER, FIXED_ACCOUNT,
// FIXED_PLAINTEXT) tuple under HKDF info "aide-gateway-credential-v1".
// Regenerating: see Task 3 Step 1 in the plan.
const V1_FIXTURE = {
  nonce: Buffer.from("070707070707070707070707", "hex"),
  // PASTE: from Task 3 Step 1 node script output for credential
  ciphertext: Buffer.from("<PASTE_CIPHERTEXT_HEX>", "hex"),
  authTag: Buffer.from("<PASTE_AUTH_TAG_HEX>", "hex"),
};

describe("credentialCipher", () => {
  it("CURRENT version is 2", () => {
    expect(CURRENT_CREDENTIAL_CIPHER_VERSION).toBe(2);
  });

  it("encrypt + decrypt v2 round-trips", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      plaintext: FIXED_PLAINTEXT,
    });
    expect(sealed.version).toBe(2);
    const recovered = decryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      sealed,
      version: 2,
    });
    expect(recovered).toBe(FIXED_PLAINTEXT);
  });

  it("decrypts pre-recorded v1 fixture with version: 1", () => {
    const recovered = decryptCredential({
      masterKeyHex: FIXED_MASTER,
      accountId: FIXED_ACCOUNT,
      sealed: V1_FIXTURE,
      version: 1,
    });
    expect(recovered).toBe(FIXED_PLAINTEXT);
  });

  it("v1 ciphertext with version: 2 throws (auth tag mismatch)", () => {
    expect(() =>
      decryptCredential({
        masterKeyHex: FIXED_MASTER,
        accountId: FIXED_ACCOUNT,
        sealed: V1_FIXTURE,
        version: 2,
      }),
    ).toThrow();
  });

  it("v2 ciphertext with version: 1 throws", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      plaintext: FIXED_PLAINTEXT,
    });
    expect(() =>
      decryptCredential({
        masterKeyHex: masterKey,
        accountId: FIXED_ACCOUNT,
        sealed,
        version: 1,
      }),
    ).toThrow();
  });

  it("fails to decrypt with wrong accountId (HKDF salt mismatch)", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: "a",
      plaintext: FIXED_PLAINTEXT,
    });
    expect(() =>
      decryptCredential({
        masterKeyHex: masterKey,
        accountId: "b",
        sealed,
        version: 2,
      }),
    ).toThrow();
  });

  it("validates master key format (32 bytes hex)", () => {
    expect(() =>
      encryptCredential({
        masterKeyHex: "too-short",
        accountId: FIXED_ACCOUNT,
        plaintext: FIXED_PLAINTEXT,
      }),
    ).toThrow();
  });

  it("throws when ciphertext is tampered", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      plaintext: FIXED_PLAINTEXT,
    });
    const tampered = {
      ...sealed,
      ciphertext: Buffer.concat([
        sealed.ciphertext.subarray(0, sealed.ciphertext.length - 1),
        Buffer.from([0xff]),
      ]),
    };
    expect(() =>
      decryptCredential({
        masterKeyHex: masterKey,
        accountId: FIXED_ACCOUNT,
        sealed: tampered,
        version: 2,
      }),
    ).toThrow();
  });
});
```

After pasting, **replace `<PASTE_CIPHERTEXT_HEX>` and `<PASTE_AUTH_TAG_HEX>` with the actual hex strings from Step 1's node script.** Do not leave the literal placeholder strings — the test will fail with `Buffer.from("<PASTE_...", "hex")` returning an empty buffer.

- [ ] **Step 3: Create `tests/bodyCipher.test.ts`**

Create the file with parallel structure (uses requestId as salt, body info string):

```typescript
import { describe, it, expect } from "vitest";
import {
  encryptBodyRaw,
  decryptBodyRaw,
  CURRENT_BODY_CIPHER_VERSION,
} from "../src/crypto/bodyCipher";
import { randomBytes } from "crypto";

const FIXED_MASTER = "a".repeat(64);
const FIXED_REQUEST = "req-test-1";
const FIXED_PLAINTEXT = "hello body v1";

const V1_FIXTURE = {
  nonce: Buffer.from("070707070707070707070707", "hex"),
  // PASTE: from Task 3 Step 1 node script output for body
  ciphertext: Buffer.from("<PASTE_CIPHERTEXT_HEX>", "hex"),
  authTag: Buffer.from("<PASTE_AUTH_TAG_HEX>", "hex"),
};

describe("bodyCipher", () => {
  it("CURRENT version is 2", () => {
    expect(CURRENT_BODY_CIPHER_VERSION).toBe(2);
  });

  it("encrypt + decrypt v2 round-trips", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: FIXED_REQUEST,
      plaintext: FIXED_PLAINTEXT,
    });
    expect(sealed.version).toBe(2);
    const recovered = decryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: FIXED_REQUEST,
      sealed,
      version: 2,
    });
    expect(recovered).toBe(FIXED_PLAINTEXT);
  });

  it("decrypts pre-recorded v1 fixture with version: 1", () => {
    const recovered = decryptBodyRaw({
      masterKeyHex: FIXED_MASTER,
      requestId: FIXED_REQUEST,
      sealed: V1_FIXTURE,
      version: 1,
    });
    expect(recovered).toBe(FIXED_PLAINTEXT);
  });

  it("v1 ciphertext with version: 2 throws", () => {
    expect(() =>
      decryptBodyRaw({
        masterKeyHex: FIXED_MASTER,
        requestId: FIXED_REQUEST,
        sealed: V1_FIXTURE,
        version: 2,
      }),
    ).toThrow();
  });

  it("v2 ciphertext with version: 1 throws", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: FIXED_REQUEST,
      plaintext: FIXED_PLAINTEXT,
    });
    expect(() =>
      decryptBodyRaw({
        masterKeyHex: masterKey,
        requestId: FIXED_REQUEST,
        sealed,
        version: 1,
      }),
    ).toThrow();
  });

  it("fails to decrypt with wrong requestId (HKDF salt mismatch)", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptBodyRaw({
      masterKeyHex: masterKey,
      requestId: "req-a",
      plaintext: FIXED_PLAINTEXT,
    });
    expect(() =>
      decryptBodyRaw({
        masterKeyHex: masterKey,
        requestId: "req-b",
        sealed,
        version: 2,
      }),
    ).toThrow();
  });
});
```

Paste the body-cipher hex strings from Step 1's second invocation.

- [ ] **Step 4: Run tests**

Run:
```bash
pnpm --filter @caliber/gateway-core test tests/credentialCipher.test.ts tests/bodyCipher.test.ts
```
Expected: all tests PASS. If the v1 fixture decrypt tests fail, the pasted hex strings are wrong — re-run the Step 1 node script and re-paste.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-core/tests/credentialCipher.test.ts packages/gateway-core/tests/bodyCipher.test.ts
git commit -m "test(gateway-core): cipher v1/v2 dispatch + pre-recorded v1 fixtures (#121)

Adds bodyCipher.test.ts (new) and rewrites credentialCipher.test.ts
to exercise both v1 (via deterministic pre-recorded fixture) and v2
(via round-trip). Verifies version-mismatch decrypts throw and that
encrypt always writes v2."
```

---

## Task 4: Update body encrypt/decrypt wrapper

**Files:**
- Modify: `apps/gateway/src/capture/encrypt.ts`

- [ ] **Step 1: Rewrite the wrapper**

Replace the entire content with:

```typescript
import {
  encryptBodyRaw,
  decryptBodyRaw,
  type BodyCipherVersion,
} from '@caliber/gateway-core'

const NONCE_LEN = 12
const TAG_LEN = 16

export interface EncryptBodyInput {
  masterKeyHex: string
  requestId: string
  plaintext: string
}

export interface DecryptBodyInput {
  masterKeyHex: string
  requestId: string
  sealed: Buffer
  version: BodyCipherVersion
}

export interface EncryptBodyResult {
  sealed: Buffer
  version: 2
}

export function encryptBody(input: EncryptBodyInput): EncryptBodyResult {
  const { nonce, ciphertext, authTag, version } = encryptBodyRaw(input)
  return {
    sealed: Buffer.concat([nonce, ciphertext, authTag]),
    version,
  }
}

export function decryptBody(input: DecryptBodyInput): string {
  const { sealed, masterKeyHex, requestId, version } = input
  if (sealed.length < NONCE_LEN + TAG_LEN) {
    throw new Error('sealed buffer too small')
  }
  const nonce = sealed.subarray(0, NONCE_LEN)
  const authTag = sealed.subarray(sealed.length - TAG_LEN)
  const ciphertext = sealed.subarray(NONCE_LEN, sealed.length - TAG_LEN)
  return decryptBodyRaw({
    masterKeyHex,
    requestId,
    sealed: { nonce, ciphertext, authTag },
    version,
  })
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm --filter @caliber/gateway typecheck 2>&1 | grep "capture/encrypt"
```
Expected: no errors from `capture/encrypt.ts` itself; callers (Task 5, Task 6) still fail until those tasks land.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/capture/encrypt.ts
git commit -m "refactor(gateway): body encrypt wrapper returns version, decrypt takes version (#121)

encryptBody now returns { sealed: Buffer, version: 2 } so the caller
can persist cipher_version alongside the bytea. decryptBody requires
a version: 1 | 2 parameter that callers supply from the row's
cipher_version column."
```

---

## Task 5: bodyCapturePersist writer — set cipher_version

**Files:**
- Modify: `apps/gateway/src/workers/bodyCapturePersist.ts`

- [ ] **Step 1: Adapt encrypt-call destructuring + INSERT values**

In `bodyCapturePersist.ts`, the four `encryptBody` call sites currently bind their results directly into Buffer variables (`requestBodySealed`, `responseBodySealed`, `thinkingBodySealed`, `attemptErrorsSealed`). After Task 4 the return type is `{ sealed: Buffer, version: 2 }`. Destructure and pull a single shared version constant for the INSERT.

Replace the existing `Step 3: encrypt each body separately…` block plus the `Step 4: INSERT…` block (lines roughly 53–109) with:

```typescript
  // Step 3: encrypt each body separately with requestId as salt
  const requestBodyEnc = encryptBody({
    masterKeyHex,
    requestId: payload.requestId,
    plaintext: truncated.requestBody,
  });
  const responseBodyEnc = encryptBody({
    masterKeyHex,
    requestId: payload.requestId,
    plaintext: truncated.responseBody,
  });
  const thinkingBodyEnc =
    truncated.thinkingBody !== null
      ? encryptBody({
          masterKeyHex,
          requestId: payload.requestId,
          plaintext: truncated.thinkingBody,
        })
      : null;
  const attemptErrorsEnc =
    truncated.attemptErrors !== null
      ? encryptBody({
          masterKeyHex,
          requestId: payload.requestId,
          plaintext: truncated.attemptErrors,
        })
      : null;

  // All four sealed columns share the same cipher_version because they
  // are written together. Take it from any one of the encrypt calls.
  const cipherVersion = requestBodyEnc.version;

  const retentionUntil = new Date(
    now.getTime() + payload.retentionDays * 24 * 60 * 60 * 1000,
  );

  // Step 4: INSERT ON CONFLICT DO NOTHING (idempotent)
  await db
    .insert(requestBodies)
    .values({
      requestId: payload.requestId,
      orgId: payload.orgId,
      requestBodySealed: requestBodyEnc.sealed,
      responseBodySealed: responseBodyEnc.sealed,
      thinkingBodySealed: thinkingBodyEnc?.sealed ?? null,
      attemptErrorsSealed: attemptErrorsEnc?.sealed ?? null,
      cipherVersion,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requestParams: payload.requestParams as any,
      stopReason: payload.stopReason,
      clientUserAgent: payload.clientUserAgent,
      clientSessionId: payload.clientSessionId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attachmentsMeta: payload.attachmentsMeta as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cacheControlMarkers: payload.cacheControlMarkers as any,
      toolResultTruncated: truncated.toolResultTruncated,
      bodyTruncated: truncated.bodyTruncated,
      capturedAt: now,
      retentionUntil,
    })
    .onConflictDoNothing({ target: requestBodies.requestId });
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm --filter @caliber/gateway exec tsc -p tsconfig.json --noEmit 2>&1 | grep "bodyCapturePersist"
```
Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/workers/bodyCapturePersist.ts
git commit -m "feat(gateway): persist cipher_version on body capture inserts (#121)

Captures the version reported by encryptBody and writes it into
request_bodies.cipher_version. All four sealed columns share the same
version because they're encrypted together at the same callsite."
```

---

## Task 6: runRuleBased reader — pass cipherVersion to decrypt

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/runRuleBased.ts`

- [ ] **Step 1: Update safeDecrypt signature**

Find the `safeDecrypt` helper (around line 291) and update it to take a `version` argument, then pass it to `decryptBody`:

```typescript
function safeDecrypt(
  masterKeyHex: string,
  requestId: string,
  sealed: Buffer,
  version: 1 | 2,
): string {
  try {
    return decryptBody({ masterKeyHex, requestId, sealed, version });
  } catch {
    return "";
  }
}
```

- [ ] **Step 2: Pass `b.cipherVersion` at each call site**

In the `bodyRows.map((b) => {...})` block (around line 153), update both `safeDecrypt` calls to pass `b.cipherVersion as 1 | 2`. The `select()` without a field list (line 148) already returns all columns including the new `cipherVersion`, so the row has it.

Replace the two `safeDecrypt` invocations:

```typescript
    const requestBodyStr = safeDecrypt(
      masterKeyHex,
      b.requestId,
      b.requestBodySealed,
      b.cipherVersion as 1 | 2,
    );
    const responseBodyStr = safeDecrypt(
      masterKeyHex,
      b.requestId,
      b.responseBodySealed,
      b.cipherVersion as 1 | 2,
    );
```

The `as 1 | 2` cast is needed because Drizzle types `smallint` as `number`. The DB-level CHECK is implicit via the column default; runtime values come from rows we write ourselves.

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @caliber/gateway exec tsc -p tsconfig.json --noEmit 2>&1 | grep "runRuleBased"
```
Expected: no errors from this file.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/workers/evaluator/runRuleBased.ts
git commit -m "feat(gateway): evaluator dispatches body decrypt on cipher_version (#121)

safeDecrypt now takes a version parameter and forwards it. Both
request and response body decrypts read row.cipherVersion. The cast
to 1 | 2 reflects Drizzle's smallint → number type; runtime values
are bounded because writers only emit 1 (legacy) or 2 (current)."
```

---

## Task 7: resolveCredential reader — hot path

**Files:**
- Modify: `apps/gateway/src/runtime/resolveCredential.ts`

- [ ] **Step 1: Add cipherVersion to the SELECT and pass to decrypt**

In `resolveCredential.ts`, update the `.select({...})` block to include `cipherVersion`, and the `decryptCredential(...)` call to pass it:

```typescript
  const row = await db
    .select({
      nonce: credentialVault.nonce,
      ciphertext: credentialVault.ciphertext,
      authTag: credentialVault.authTag,
      cipherVersion: credentialVault.cipherVersion,
    })
    .from(credentialVault)
    .where(eq(credentialVault.accountId, accountId))
    .limit(1)
    .then((r: Array<{ nonce: Buffer; ciphertext: Buffer; authTag: Buffer; cipherVersion: number }>) => r[0]);

  if (!row) {
    throw new CredentialNotFoundError(accountId);
  }

  const plaintext = decryptCredential({
    masterKeyHex: opts.masterKeyHex,
    accountId,
    sealed: { nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.authTag },
    version: row.cipherVersion as 1 | 2,
  });
```

The `.then` type annotation is updated to include the new field.

- [ ] **Step 2: Update existing resolveCredential test for new sealed shape**

`apps/gateway/tests/runtime/resolveCredential.test.ts` line 14's helper:

```typescript
function sealed(plaintext: string, cipherVersion: 1 | 2 = 2) {
  const s = encryptCredential({ masterKeyHex: masterKey, accountId, plaintext });
  return { nonce: s.nonce, ciphertext: s.ciphertext, authTag: s.authTag, cipherVersion };
}
```

The default of `2` means existing tests continue to work without changes; the version flows through the mocked row into `decryptCredential`.

Add a new test at the bottom of the file (just before the closing `});` of the `describe`):

```typescript
  it("dispatches v1 row through decrypt path with version=1", async () => {
    // Encrypt with the current cipher (v2), then claim the row is v1.
    // This won't actually decrypt because the ciphertext was made with
    // v2 info — we expect it to throw, proving dispatch reads version.
    const row = { ...sealed(JSON.stringify({ type: "api_key", api_key: "sk-test" })), cipherVersion: 1 };
    const db = makeMockDb([row]);
    await expect(
      resolveCredential(db, accountId, { masterKeyHex: masterKey }),
    ).rejects.toThrow();
  });
```

This is sufficient because the cipher-module tests in Task 3 already prove that v1-derived ciphertext decrypts correctly when `version: 1` is passed — here we only need to prove `resolveCredential` actually reads `row.cipherVersion` and threads it into `decryptCredential`.

- [ ] **Step 3: Run tests**

Run:
```bash
pnpm --filter @caliber/gateway test tests/runtime/resolveCredential.test.ts
```
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/runtime/resolveCredential.ts apps/gateway/tests/runtime/resolveCredential.test.ts
git commit -m "feat(gateway): resolveCredential threads cipher_version through decrypt (#121)

Hot path. Reads cipher_version from credential_vault and passes it
to decryptCredential, so v1 rows continue to decrypt with the legacy
HKDF info string while new v2 rows use the caliber info. Updates the
unit-test mock helper to default cipherVersion=2 and adds a dispatch
test."
```

---

## Task 8: oauthRefresh — encrypt write + decrypt read

**Files:**
- Modify: `apps/gateway/src/runtime/oauthRefresh.ts`

- [ ] **Step 1: Update the encrypt write block (around line 442)**

After Task 2's cipher-module change, `encryptCredential` returns `{ ...sealed, version: 2 }`. Use it in the UPDATE:

Replace the `update(credentialVault).set({...})` block (around line 449–458) with:

```typescript
  const result = await db
    .update(credentialVault)
    .set({
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      authTag: sealed.authTag,
      cipherVersion: sealed.version,
      oauthExpiresAt: credential.expiresAt,
      rotatedAt: new Date(now()),
    })
    .where(and(eq(credentialVault.accountId, accountId), casCondition));
```

- [ ] **Step 2: Update the decrypt read block (around line 718)**

Replace the `.select({...})` plus the immediately-following `decryptCredential` call (lines 717–740) with:

```typescript
  const row = await db
    .select({
      nonce: credentialVault.nonce,
      ciphertext: credentialVault.ciphertext,
      authTag: credentialVault.authTag,
      cipherVersion: credentialVault.cipherVersion,
    })
    .from(credentialVault)
    .where(eq(credentialVault.accountId, accountId))
    .limit(1)
    .then((r) => r[0]);
  if (!row) {
    throw new OAuthRefreshError(
      `credential vault row missing for account ${accountId}`,
    );
  }
  const plaintext = decryptCredential({
    masterKeyHex,
    accountId,
    sealed: {
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.authTag,
    },
    version: row.cipherVersion as 1 | 2,
  });
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @caliber/gateway exec tsc -p tsconfig.json --noEmit 2>&1 | grep "oauthRefresh"
```
Expected: no errors from this file.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/runtime/oauthRefresh.ts
git commit -m "feat(gateway): oauthRefresh writes cipher_version=2 and reads with dispatch (#121)

The refresh path persists the freshly-encrypted credential into
credential_vault with cipher_version sourced from encryptCredential's
return value. The read-back-for-refresh path selects cipher_version
and threads it through decryptCredential so v1 rows still refresh
cleanly during the migration window."
```

---

## Task 9: accounts.ts admin tRPC — 3 encrypt writes

**Files:**
- Modify: `apps/api/src/trpc/routers/accounts.ts`

- [ ] **Step 1: Update the insert at line ~245 (create)**

Find the `tx.insert(credentialVault).values({...})` block (around line 245) and add `cipherVersion: sealed.version`:

```typescript
      await tx.insert(credentialVault).values({
        accountId: insertedAccount.id,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        authTag: sealed.authTag,
        cipherVersion: sealed.version,
        oauthExpiresAt:
          input.type === "oauth" ? new Date(input.credentials.expires_at) : null,
      });
```

(The exact surrounding lines vary; ensure you preserve all existing fields and only add the one new line.)

- [ ] **Step 2: Update the update at line ~395 (rotate path)**

Find the `.update(credentialVault).set({...})` block (around line 395) and add `cipherVersion: sealed.version` plus an `updatedAt`-style `rotatedAt` if the existing code does so. Concretely the `.set({...})` becomes:

```typescript
        .update(credentialVault)
        .set({
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          cipherVersion: sealed.version,
          oauthExpiresAt:
            existing.type === "oauth"
              ? new Date(input.credentials.expires_at)
              : null,
          rotatedAt: new Date(),
        })
```

If `rotatedAt` is already present, don't double-add it. If not, leave it alone — the spec doesn't require new rotatedAt writes.

- [ ] **Step 3: Update the update at line ~491 (re-onboard path)**

Same shape as Step 2 — add `cipherVersion: sealed.version` to the `.set({...})` block. Don't change other fields.

- [ ] **Step 4: Typecheck**

Run:
```bash
pnpm --filter @caliber/api exec tsc -p tsconfig.json --noEmit 2>&1 | grep "accounts"
```
Expected: no errors from this file.

- [ ] **Step 5: Run accounts router tests**

Run:
```bash
pnpm --filter @caliber/api test tests/integration/trpc/accounts.test.ts
```
Expected: all tests PASS. (Tests already mock the cipher module; the new field flows through transparently.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/trpc/routers/accounts.ts
git commit -m "feat(api): admin account mutations persist cipher_version=2 (#121)

create / rotate / re-onboard mutations now write cipher_version into
credential_vault, sourced from encryptCredential's return value."
```

---

## Task 10: Rotation script (--dry-run default, --apply to write)

**Files:**
- Create: `apps/gateway/scripts/rotate-credentials-v2.ts`

- [ ] **Step 1: Create scripts directory**

Run:
```bash
mkdir -p apps/gateway/scripts
```

- [ ] **Step 2: Write the script**

Create `apps/gateway/scripts/rotate-credentials-v2.ts`:

```typescript
/**
 * Rotation script for HKDF v1 → v2 cipher migration (#121).
 *
 * Default mode is dry-run: scans upstream_accounts + credential_vault,
 * verifies api_key rows round-trip cleanly through decrypt-v1 →
 * encrypt-v2 → decrypt-v2, and lists what would happen on --apply.
 *
 * --apply writes the new v2 sealed bytes back to credential_vault for
 * api_key accounts; for oauth accounts, it invokes refreshOAuthCredential
 * so the upstream-side OAuth refresh produces a fresh v2 row.
 *
 * Idempotent — re-running skips rows already at cipher_version=2.
 *
 * Usage:
 *   pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts
 *   pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts --apply
 */

import { eq, isNull } from "drizzle-orm";
import {
  credentialVault,
  upstreamAccounts,
  getDb,
} from "@caliber/db";
import {
  decryptCredential,
  encryptCredential,
} from "@caliber/gateway-core";
import { refreshOAuthCredential } from "../src/runtime/oauthRefresh.js";

interface AccountSummary {
  id: string;
  type: string;
}

interface RunSummary {
  apply: boolean;
  candidates: number;
  alreadyV2: number;
  apiKeyOk: number;
  apiKeyFail: number;
  oauthToRefresh: number;
  oauthRefreshed: number;
  oauthFailed: number;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const masterKeyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!masterKeyHex || !/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
    console.error(
      "CREDENTIAL_ENCRYPTION_KEY env var missing or not 32 bytes hex",
    );
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL env var missing");
    process.exit(2);
  }

  const db = getDb(databaseUrl);

  console.log(
    `[rotate] mode = ${apply ? "APPLY (will write to DB)" : "DRY-RUN (read-only)"}`,
  );

  const accounts: AccountSummary[] = await db
    .select({ id: upstreamAccounts.id, type: upstreamAccounts.type })
    .from(upstreamAccounts)
    .where(isNull(upstreamAccounts.deletedAt));

  const summary: RunSummary = {
    apply,
    candidates: accounts.length,
    alreadyV2: 0,
    apiKeyOk: 0,
    apiKeyFail: 0,
    oauthToRefresh: 0,
    oauthRefreshed: 0,
    oauthFailed: 0,
  };

  for (const acct of accounts) {
    const vaultRow = await db
      .select({
        nonce: credentialVault.nonce,
        ciphertext: credentialVault.ciphertext,
        authTag: credentialVault.authTag,
        cipherVersion: credentialVault.cipherVersion,
      })
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id))
      .limit(1)
      .then((r) => r[0]);

    if (!vaultRow) {
      console.warn(`[rotate] account ${acct.id} (${acct.type}): NO VAULT ROW — skipping`);
      continue;
    }

    if (vaultRow.cipherVersion === 2) {
      console.log(`[rotate] skip already-v2 account ${acct.id} (${acct.type})`);
      summary.alreadyV2++;
      continue;
    }

    if (acct.type === "api_key") {
      try {
        const plaintext = decryptCredential({
          masterKeyHex,
          accountId: acct.id,
          sealed: {
            nonce: vaultRow.nonce,
            ciphertext: vaultRow.ciphertext,
            authTag: vaultRow.authTag,
          },
          version: 1,
        });
        const reSealed = encryptCredential({
          masterKeyHex,
          accountId: acct.id,
          plaintext,
        });
        const verifyRoundTrip = decryptCredential({
          masterKeyHex,
          accountId: acct.id,
          sealed: {
            nonce: reSealed.nonce,
            ciphertext: reSealed.ciphertext,
            authTag: reSealed.authTag,
          },
          version: 2,
        });
        if (verifyRoundTrip !== plaintext) {
          throw new Error("round-trip plaintext mismatch");
        }

        if (apply) {
          await db
            .update(credentialVault)
            .set({
              nonce: reSealed.nonce,
              ciphertext: reSealed.ciphertext,
              authTag: reSealed.authTag,
              cipherVersion: reSealed.version,
              rotatedAt: new Date(),
            })
            .where(eq(credentialVault.accountId, acct.id));
          console.log(`[rotate] APPLIED api_key account ${acct.id}`);
        } else {
          console.log(`[DRY] would rotate api_key account ${acct.id}: round-trip OK`);
        }
        summary.apiKeyOk++;
      } catch (err) {
        console.error(
          `[rotate] FAIL api_key account ${acct.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.apiKeyFail++;
      }
      continue;
    }

    if (acct.type === "oauth") {
      if (!apply) {
        console.log(`[DRY] would force refresh oauth account ${acct.id}`);
        summary.oauthToRefresh++;
        continue;
      }
      try {
        await refreshOAuthCredential({
          db,
          accountId: acct.id,
          masterKeyHex,
          force: true,
        });
        console.log(`[rotate] REFRESHED oauth account ${acct.id}`);
        summary.oauthRefreshed++;
      } catch (err) {
        console.error(
          `[rotate] FAIL oauth refresh ${acct.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.oauthFailed++;
      }
      continue;
    }

    console.warn(`[rotate] unknown type for account ${acct.id}: ${acct.type}`);
  }

  console.log("[rotate] summary:", JSON.stringify(summary, null, 2));

  // Exit non-zero on dry-run if any api_key candidate failed round-trip
  // (signals corrupt vault row that needs manual investigation before apply).
  if (!apply && summary.apiKeyFail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[rotate] fatal:", err);
  process.exit(1);
});
```

If `refreshOAuthCredential` is not exported from `oauthRefresh.ts` with the exact `{ db, accountId, masterKeyHex, force }` shape, inspect the existing signature with `grep -n "export.*function" apps/gateway/src/runtime/oauthRefresh.ts` and adapt the call. The intent is "force a refresh for one account regardless of current expiry"; the exact API may need an `OAuthRefreshOptions` import.

- [ ] **Step 3: Sanity smoke (no DB write)**

Run:
```bash
DATABASE_URL=postgresql://caliber:caliber_dev@localhost:5432/caliber \
CREDENTIAL_ENCRYPTION_KEY=$(printf 'a%.0s' {1..64}) \
pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts
```

Expected: script runs without crashing. If no accounts exist locally, output is just `summary: { candidates: 0, ... }`. If accounts exist, each row is logged with `[DRY] ...`. Verify no `UPDATE credential_vault` SQL was emitted (turn on `DRIZZLE_LOG=1` to inspect if needed).

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/scripts/rotate-credentials-v2.ts
git commit -m "feat(gateway): rotate-credentials-v2 ops script (#121)

Standalone tsx script. Default dry-run: verifies api_key round-trip
(decrypt-v1 → encrypt-v2 → decrypt-v2 equals original plaintext) and
logs intent for oauth accounts without contacting Anthropic.

--apply writes new v2 sealed bytes for api_key rows (per-account
UPDATE with cipher_version=2 and rotatedAt=now) and invokes
refreshOAuthCredential for oauth rows. Per-row failure isolated:
batch continues; failures logged to stderr.

Exit code 1 on dry-run if any api_key candidate fails round-trip
(signals corrupt vault that operator must investigate before apply)."
```

---

## Task 11: Rotation script tests

**Files:**
- Create: `apps/gateway/scripts/__tests__/rotate-credentials-v2.test.ts`

- [ ] **Step 1: Decide test strategy**

The script reads `DATABASE_URL` and writes to live tables. For unit tests, factor the core loop into a testable function. Refactor `apps/gateway/scripts/rotate-credentials-v2.ts` to export a `rotateAll` function that accepts `(db, masterKeyHex, opts)` and contains the loop. Keep `main()` as the thin CLI wrapper around it.

Update the script: extract the loop into `export async function rotateAll(opts: { db, masterKeyHex, apply, refresh }): Promise<RunSummary>` where `refresh` is an injectable `(accountId: string) => Promise<void>` so tests can mock the OAuth refresh path without hitting Anthropic. `main()` constructs the real refresh closure: `(id) => refreshOAuthCredential({ db, accountId: id, masterKeyHex, force: true })`.

- [ ] **Step 2: Create the test**

Create `apps/gateway/scripts/__tests__/rotate-credentials-v2.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { rotateAll } from "../rotate-credentials-v2";
import { encryptCredential } from "@caliber/gateway-core";

const MASTER = "a".repeat(64);

function makeApiKeyV1Row(accountId: string, apiKey: string) {
  // Manually produce a v1 sealed buffer by calling the low-level
  // encryptAesGcm with the v1 info string. We use the public
  // encryptCredential (which is v2) and re-derive v1 by writing a
  // direct call. For brevity, the test imports encryptAesGcm.
  // ... see implementation note below.
  return encryptCredentialV1(MASTER, accountId, JSON.stringify({ type: "api_key", api_key: apiKey }));
}

// Helper: writes a v1 sealed row using the v1 HKDF info string.
function encryptCredentialV1(masterKey: string, accountId: string, plaintext: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hkdfSync, createCipheriv, randomBytes } = require("crypto");
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(masterKey, "hex"),
      Buffer.from(accountId, "utf8"),
      Buffer.from("aide-gateway-credential-v1", "utf8"),
      32,
    ),
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext: ct, authTag: tag };
}

interface FakeRow {
  accountId: string;
  type: string;
  deletedAt: Date | null;
  vault: {
    nonce: Buffer;
    ciphertext: Buffer;
    authTag: Buffer;
    cipherVersion: number;
  } | null;
}

function makeFakeDb(rows: FakeRow[]) {
  // Minimal stub that satisfies the script's drizzle usage shape.
  const updates: Array<{ accountId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer; cipherVersion: number }> = [];

  const db: any = {
    select: (cols: any) => ({
      from: (table: any) => ({
        where: (_pred: any) => {
          // Heuristic: if cols mentions upstreamAccounts.id, return all accounts;
          // otherwise return the vault row for the eq predicate's accountId.
          // The script uses fluent chains; simplify by inspecting the table
          // identity using a name string.
          const t = String(table?.name ?? table);
          if (t.includes("upstream_accounts")) {
            return Promise.resolve(
              rows
                .filter((r) => r.deletedAt === null)
                .map((r) => ({ id: r.accountId, type: r.type })),
            );
          }
          return {
            limit: () => ({
              then: (cb: any) => {
                // Extract accountId from the chain's stored eq target — we cheat
                // by reading it from a side-channel set in eq() below.
                const target = (db as any).__lastEqAccountId;
                const r = rows.find((x) => x.accountId === target);
                return Promise.resolve(cb(r?.vault ? [{ ...r.vault }] : []));
              },
            }),
          };
        },
      }),
    }),
    update: (_table: any) => ({
      set: (vals: any) => ({
        where: async (_pred: any) => {
          const target = (db as any).__lastEqAccountId;
          updates.push({ accountId: target, ...vals });
          return { rowCount: 1 };
        },
      }),
    }),
  };
  return { db, updates };
}

// The script imports `eq` from drizzle-orm; intercept it to capture the
// accountId target so makeFakeDb above can find the right row.
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (_col: any, val: any) => {
      // Side-channel: store on the global so makeFakeDb can read.
      (globalThis as any).__lastEqAccountId = val;
      return { __eq: val };
    },
    isNull: (_col: any) => ({ __isNull: true }),
  };
});

// And expose the side-channel slot on the db when constructed.
function dbWithSideChannel(rows: FakeRow[]) {
  const { db, updates } = makeFakeDb(rows);
  Object.defineProperty(db, "__lastEqAccountId", {
    get() {
      return (globalThis as any).__lastEqAccountId;
    },
  });
  return { db, updates };
}

describe("rotateAll", () => {
  beforeEach(() => {
    (globalThis as any).__lastEqAccountId = undefined;
  });

  it("dry-run on v1 api_key row: round-trip OK, no DB write", async () => {
    const accountId = "11111111-1111-1111-1111-111111111111";
    const sealed = makeApiKeyV1Row(accountId, "sk-test");
    const { db, updates } = dbWithSideChannel([
      {
        accountId,
        type: "api_key",
        deletedAt: null,
        vault: { ...sealed, cipherVersion: 1 },
      },
    ]);
    const refresh = vi.fn();

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: false,
      refresh,
    });

    expect(summary.apiKeyOk).toBe(1);
    expect(summary.apiKeyFail).toBe(0);
    expect(updates).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("dry-run on v1 oauth row: logs intent, does NOT call refresh", async () => {
    const accountId = "22222222-2222-2222-2222-222222222222";
    const sealed = makeApiKeyV1Row(accountId, "sk-test");
    const { db, updates } = dbWithSideChannel([
      {
        accountId,
        type: "oauth",
        deletedAt: null,
        vault: { ...sealed, cipherVersion: 1 },
      },
    ]);
    const refresh = vi.fn();

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: false,
      refresh,
    });

    expect(summary.oauthToRefresh).toBe(1);
    expect(summary.oauthRefreshed).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("apply on v1 api_key row: writes new v2 row, plaintext preserved", async () => {
    const accountId = "33333333-3333-3333-3333-333333333333";
    const sealed = makeApiKeyV1Row(accountId, "sk-test");
    const { db, updates } = dbWithSideChannel([
      {
        accountId,
        type: "api_key",
        deletedAt: null,
        vault: { ...sealed, cipherVersion: 1 },
      },
    ]);
    const refresh = vi.fn();

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: true,
      refresh,
    });

    expect(summary.apiKeyOk).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].cipherVersion).toBe(2);
    // Note: we don't decrypt-verify here because rotateAll already
    // proved round-trip inline; this test just confirms the UPDATE
    // was emitted with version=2.
  });

  it("apply on v1 oauth row: calls refresh function", async () => {
    const accountId = "44444444-4444-4444-4444-444444444444";
    const sealed = makeApiKeyV1Row(accountId, "sk-test");
    const { db } = dbWithSideChannel([
      {
        accountId,
        type: "oauth",
        deletedAt: null,
        vault: { ...sealed, cipherVersion: 1 },
      },
    ]);
    const refresh = vi.fn().mockResolvedValue(undefined);

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: true,
      refresh,
    });

    expect(summary.oauthRefreshed).toBe(1);
    expect(summary.oauthFailed).toBe(0);
    expect(refresh).toHaveBeenCalledWith(accountId);
  });

  it("already-v2 row is skipped on both dry-run and apply", async () => {
    const accountId = "55555555-5555-5555-5555-555555555555";
    const v2Sealed = encryptCredential({
      masterKeyHex: MASTER,
      accountId,
      plaintext: JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    });
    const { db, updates } = dbWithSideChannel([
      {
        accountId,
        type: "api_key",
        deletedAt: null,
        vault: {
          nonce: v2Sealed.nonce,
          ciphertext: v2Sealed.ciphertext,
          authTag: v2Sealed.authTag,
          cipherVersion: 2,
        },
      },
    ]);
    const refresh = vi.fn();

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: true,
      refresh,
    });

    expect(summary.alreadyV2).toBe(1);
    expect(updates).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("one oauth refresh failure does not abort batch", async () => {
    const a = "66666666-6666-6666-6666-666666666666";
    const b = "77777777-7777-7777-7777-777777777777";
    const sealedA = makeApiKeyV1Row(a, "ax");
    const sealedB = makeApiKeyV1Row(b, "bx");
    const { db } = dbWithSideChannel([
      { accountId: a, type: "oauth", deletedAt: null, vault: { ...sealedA, cipherVersion: 1 } },
      { accountId: b, type: "oauth", deletedAt: null, vault: { ...sealedB, cipherVersion: 1 } },
    ]);
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const summary = await rotateAll({
      db,
      masterKeyHex: MASTER,
      apply: true,
      refresh,
    });

    expect(summary.oauthFailed).toBe(1);
    expect(summary.oauthRefreshed).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
```

This test is hand-rolling a minimal drizzle-shaped stub. If the real script's drizzle chain shape evolves and the stub breaks, simplify by extracting the script's per-account work into a small pure function that takes `{ accountId, type, vaultRow, masterKeyHex }` and returns either `{ kind: 'updated-v2', sealed }` or `{ kind: 'oauth-needs-refresh' }` or `{ kind: 'api-key-fail', error }`. Then the test can call that pure function directly without the drizzle stub.

- [ ] **Step 3: Run tests**

Run:
```bash
pnpm --filter @caliber/gateway test scripts/__tests__/rotate-credentials-v2.test.ts
```
Expected: all 6 tests PASS. If the drizzle-stub heuristics fail, refactor to the pure-function approach noted in Step 2.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/scripts/rotate-credentials-v2.ts apps/gateway/scripts/__tests__/rotate-credentials-v2.test.ts
git commit -m "test(gateway): rotateAll covers dry-run, apply, idempotency, failure isolation (#121)

Splits the script's CLI wrapper from the testable rotateAll function
(injects the refresh callback) and adds vitest coverage for:
- dry-run on v1 api_key: round-trip OK, no DB write
- dry-run on v1 oauth: logs intent without calling refresh
- apply on v1 api_key: UPDATE emitted with cipher_version=2
- apply on v1 oauth: refresh callback invoked once
- already-v2 row: skipped on both modes
- one oauth failure in a batch: remaining rows still processed"
```

---

## Task 12: Full build + integration verification

**Files:** none modified (verification only)

- [ ] **Step 1: Workspace-wide typecheck**

Run:
```bash
pnpm -r typecheck
```
Expected: green across every package.

- [ ] **Step 2: Workspace-wide unit tests**

Run:
```bash
pnpm -r test
```
Expected: green across every package. If `oauthRefresh.integration.test.ts` or `bodyCaptureWorker.integration.test.ts` fails because the integration DB doesn't have `cipher_version`, run `pnpm --filter @caliber/db db:migrate` against the integration DB first.

- [ ] **Step 3: Smoke the gateway locally**

Boot the docker stack via the operator's usual flow (`docker compose up`). Hit one request:

```bash
curl -sX POST http://localhost:3002/v1/messages \
  -H "x-api-key: <a real apiKey from your local DB>" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

Expected: 200 OK with a normal response. Then in psql:

```sql
SELECT cipher_version, COUNT(*)
FROM request_bodies
WHERE captured_at >= now() - interval '5 minutes'
GROUP BY cipher_version;
```
Expected: at least one row with `cipher_version = 2`. If the body-capture worker is not running locally, this row may not appear; in that case verify by running the worker explicitly.

- [ ] **Step 4: No commit** (verification only). Move to Task 13.

---

## Task 13: Open follow-up issue (Phase 4b cleanup)

**Files:** none modified — this is a GitHub action.

- [ ] **Step 1: Open the issue**

Run:
```bash
gh issue create --repo hanfour/aide \
  --title "Phase 4b cleanup: drop HKDF v1 cipher path + cipher_version column" \
  --label rebrand --label cleanup \
  --body "$(cat <<'EOF'
Deferred cleanup from #121. Blocked by 90-day \`request_bodies\` retention drain from the merge date of the #121 PR.

## Why deferred

Bodies cannot be re-encrypted in place (would require holding bulk plaintext); they migrate naturally as the 90-day retention cron purges old rows. After T+90 days from #121 merge, all surviving \`request_bodies\` should be \`cipher_version = 2\`.

## Acceptance

- [ ] \`SELECT cipher_version, COUNT(*) FROM request_bodies GROUP BY 1\` returns only \`2\` (or zero \`v1\` rows; manual \`DELETE\` of a small tail is acceptable)
- [ ] Drop \`BODY_INFO_V1\`, \`CREDENTIAL_INFO_V1\`, \`BodyCipherVersion\`, \`CredentialCipherVersion\` from \`packages/gateway-core/src/crypto/\`
- [ ] Drop the \`version\` parameter from \`decrypt*\` signatures (single-version API)
- [ ] Decide on the \`cipher_version\` column itself — drop (cleaner) or keep (prep for future v3)
- [ ] Drop \`apps/gateway/scripts/rotate-credentials-v2.ts\` and its test
- [ ] Remove the v1→v2 runbook section from operator docs

## How to verify the drain is complete

\`\`\`sql
-- All bodies v2
SELECT cipher_version, COUNT(*) FROM request_bodies GROUP BY 1;
-- All credentials v2
SELECT cipher_version, COUNT(*) FROM credential_vault GROUP BY 1;
\`\`\`

Both should report cipher_version = 2 only.

## Source

Tracked in the design doc:
\`docs/superpowers/specs/2026-05-11-hkdf-v2-migration-design.md\`
EOF
)"
```

Capture the issue number printed. It will be referenced in the PR body for Task 14.

- [ ] **Step 2: No commit** (issue is on GitHub). Move to Task 14.

---

## Task 14: Push branch + open PR + watch CI

- [ ] **Step 1: Sanity check log**

Run: `git log --oneline main..HEAD`

Expected output (12 commits including spec + plan): one spec commit `f503b03`, one plan commit (new from this Task), then 10 implementation commits from Tasks 1–11.

- [ ] **Step 2: Commit the plan itself**

The plan you are reading should be committed before the implementation commits land. If the plan was committed earlier (alongside the spec), skip this step. Otherwise:

```bash
git add docs/superpowers/plans/2026-05-11-hkdf-v2-migration.md
git commit -m "docs(plan): implementation plan for HKDF v2 cipher migration (#121)"
```

- [ ] **Step 3: Push branch**

```bash
git push -u origin refactor/121-hkdf-v2-migration
```

- [ ] **Step 4: Open PR**

```bash
gh pr create --repo hanfour/aide \
  --base main \
  --head refactor/121-hkdf-v2-migration \
  --title "feat: HKDF v1 → v2 cipher migration with rotation script (#121)" \
  --body "$(cat <<'EOF'
## TL;DR

Rotates HKDF \`info\` strings for body + credential ciphers from \`aide-gateway-*-v1\` to \`caliber-gateway-*-v2\` with zero gateway downtime. New writes are v2; old rows decrypt via dispatch on a new \`cipher_version\` column. Manual rotation script (\`--dry-run\` default) backfills \`credential_vault\` rows.

## Why

Closes #121. Final cipher-side leftover of the aide → Caliber rebrand. PR #117 migrated infra identifiers; PR #128 migrated docs + Prometheus; this PR migrates the HKDF info strings that derive per-record encryption keys. The change is high-risk because mistakes corrupt persisted encrypted data — see spec doc for full design.

## What's in

- **Schema** (\`packages/db/drizzle/0012_cipher_version.sql\`): adds \`cipher_version SMALLINT NOT NULL DEFAULT 1\` to \`credential_vault\` and \`request_bodies\`. Online-safe (metadata-only on postgres 11+).
- **Cipher module** (\`packages/gateway-core/src/crypto/{bodyCipher,credentialCipher}.ts\`): adds \`BODY_INFO_V1/V2\` + \`CREDENTIAL_INFO_V1/V2\`. \`encrypt*\` always writes v2 and returns \`{...sealed, version: 2}\`. \`decrypt*\` accepts \`version: 1 | 2\` and dispatches.
- **Caller threading**: 6 sites updated (\`apps/gateway/src/{capture/encrypt,workers/bodyCapturePersist,workers/evaluator/runRuleBased,runtime/resolveCredential,runtime/oauthRefresh}.ts\` + \`apps/api/src/trpc/routers/accounts.ts\`).
- **Rotation script** (\`apps/gateway/scripts/rotate-credentials-v2.ts\`): \`--dry-run\` default (read-only round-trip verification), \`--apply\` writes new v2 sealed bytes for \`api_key\` rows and invokes \`refreshOAuthCredential\` for \`oauth\` rows. Idempotent (skips already-v2 rows).
- **Tests**: cipher v1 fixture decrypts + v2 round-trip + version-mismatch throws; \`resolveCredential\` dispatch test; rotation script unit tests covering dry-run / apply / idempotency / failure isolation.
- **Spec + plan**: \`docs/superpowers/specs/2026-05-11-hkdf-v2-migration-design.md\` + \`docs/superpowers/plans/2026-05-11-hkdf-v2-migration.md\`.

## What's NOT in (filed as follow-up)

- Drop of v1 paths + decrypt parameter + (optionally) the \`cipher_version\` column → blocked on T+90 days for body retention drain. See the follow-up issue this PR opens.
- Master key rotation — explicitly out of scope; only the HKDF info string changes.

## Tests

- \`pnpm -r typecheck\` green
- \`pnpm -r test\` green
- Cipher module: deterministic v1 fixtures verify backwards-compatibility forever
- Rotation script: 6 unit tests (dry-run/apply × api_key/oauth, idempotency, batch failure isolation)
- Manual smoke: one /v1/messages request after deploy → \`request_bodies.cipher_version = 2\`

## Operator upgrade

After merging this PR, in order:

1. Deploy the new gateway + api images.
2. Smoke-test one request through the gateway; confirm logs show no decrypt failure and one new \`request_bodies\` row has \`cipher_version = 2\`.
3. Run the rotation script in **dry-run**:
   \`\`\`
   pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts
   \`\`\`
   Confirm summary shows all \`api_key\` candidates round-trip OK.
4. Run with **\`--apply\`**:
   \`\`\`
   pnpm --filter @caliber/gateway exec tsx scripts/rotate-credentials-v2.ts --apply
   \`\`\`
5. Verify in SQL: \`SELECT cipher_version, COUNT(*) FROM credential_vault GROUP BY 1\` returns only \`2\` (or only \`oauth\` rows that failed refresh — retry the script for those).
6. Record the merge date; Phase 4b cleanup is gated on T+90 days. See follow-up issue opened by this PR.

## Closes

Closes #121.
EOF
)"
```

- [ ] **Step 5: Capture PR number and watch CI**

The previous command prints a URL like `https://github.com/hanfour/aide/pull/NNN`. Run:

```bash
gh pr checks <NN> --repo hanfour/aide --watch
```

Expected: all 6 checks pass (lint-type-test, integration, gateway-integration, evaluator-integration, coverage, e2e). The cipher change touches encrypted persistence — pay extra attention to `gateway-integration` and `oauthRefresh.integration.test.ts` results. If any check fails, fix in a new commit (never amend) and push.

Do NOT merge in this task — final code review + user authorisation comes after.

---

## Self-review

**Spec coverage:**

- Schema migration (cipher_version on both tables) → Task 1 ✓
- Cipher module dual-version API → Task 2 ✓
- Cipher v1 fixture + v2 round-trip tests → Task 3 ✓
- Body wrapper update (return version on encrypt, accept version on decrypt) → Task 4 ✓
- bodyCapturePersist writes cipher_version → Task 5 ✓
- runRuleBased dispatches on cipher_version → Task 6 ✓
- resolveCredential dispatches on cipher_version → Task 7 ✓
- oauthRefresh encrypts as v2, decrypts via dispatch → Task 8 ✓
- accounts.ts admin tRPC writes cipher_version → Task 9 ✓
- Rotation script with --dry-run/--apply → Task 10 ✓
- Rotation script tests (dry-run/apply, idempotency, failure isolation) → Task 11 ✓
- Workspace verification + smoke → Task 12 ✓
- Follow-up issue (Phase 4b cleanup, T+90 days) → Task 13 ✓
- Push + PR + CI → Task 14 ✓

**Placeholder scan:**

- No `TBD` / `TODO` / `implement later` anywhere.
- The two `<PASTE_CIPHERTEXT_HEX>` / `<PASTE_AUTH_TAG_HEX>` placeholders in Task 3 are intentional — the engineer must run the deterministic node script in Step 1 and paste the actual hex output. The plan explicitly warns "Do not leave the literal placeholder strings".
- The `<NN>` placeholder in Task 14 Step 5 is the genuine "PR number unknown until `gh pr create` returns" case.

**Type consistency:**

- `cipherVersion` (Drizzle camelCase) and `cipher_version` (SQL snake_case) used consistently per their layer. Drizzle does the conversion.
- `version: 1 | 2` parameter shape identical in `decryptBody`, `decryptCredential`, `decryptBodyRaw`, `decryptCredentialRaw`, and rotation-script call sites.
- `encrypt*` return shape `{nonce, ciphertext, authTag, version: 2}` consistent — Tasks 5, 8, 9 all destructure `sealed.version`.
- The `as 1 | 2` cast appears in Tasks 6, 7, 8 because Drizzle types `smallint` as `number`. Cast is documented in Task 6 commit message.
- `refreshOAuthCredential` signature is assumed `({ db, accountId, masterKeyHex, force })` in Task 10. Task 10 Step 2 notes that if the real signature differs, the engineer must adapt. The fallback (extract a pure function for testability) is noted in Task 11 Step 2.

**Risk-tier check:**

- High-risk tasks (5, 7, 8, 10) all have either unit tests in the same task or in a paired test task (3, 11).
- Task 7 explicitly notes resolveCredential is the gateway's hot path; the dispatch test added there mocks a v1 row to prove `row.cipherVersion` is actually consulted.
- Task 10's rotation script defaults to dry-run; an operator running the wrong command does no damage.
- Task 12 explicitly runs `pnpm --filter @caliber/db db:migrate` before integration tests, preventing the most common "tests fail because integration DB schema is stale" trap.


