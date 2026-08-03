import { encryptAesGcm, decryptAesGcm, type Sealed } from './aesGcmHkdf.js'

export type SealedBody = Sealed

const BODY_INFO = Buffer.from('caliber-gateway-body-v2', 'utf8')

interface EncryptBodyInput {
  masterKeyHex: string
  requestId: string
  plaintext: string
}

interface DecryptBodyInput {
  masterKeyHex: string
  requestId: string
  sealed: SealedBody
}

export function encryptBodyRaw(input: EncryptBodyInput): SealedBody {
  return encryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: BODY_INFO,
    salt: input.requestId,
    plaintext: input.plaintext,
  })
}

export function decryptBodyRaw(input: DecryptBodyInput): string {
  return decryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: BODY_INFO,
    salt: input.requestId,
    sealed: input.sealed,
  })
}

// ── Stored framing ───────────────────────────────────────────────────────────
//
// `request_bodies.*_sealed` is a single `bytea`, so the three parts above are
// concatenated as `nonce || ciphertext || authTag`. That layout is a STORAGE
// FORMAT, not an implementation detail of whoever happens to write the rows:
// apps/gateway writes them and apps/api (the replay comparison endpoint) reads
// them back. Both sides must agree forever, so the framing lives here — the
// one package both depend on — rather than being spelled out twice.

const NONCE_LEN = 12
const TAG_LEN = 16

export function packSealedBody(sealed: SealedBody): Buffer {
  return Buffer.concat([sealed.nonce, sealed.ciphertext, sealed.authTag])
}

export function unpackSealedBody(stored: Buffer): SealedBody {
  if (stored.length < NONCE_LEN + TAG_LEN) {
    throw new Error('sealed buffer too small')
  }
  return {
    nonce: stored.subarray(0, NONCE_LEN),
    ciphertext: stored.subarray(NONCE_LEN, stored.length - TAG_LEN),
    authTag: stored.subarray(stored.length - TAG_LEN),
  }
}

/** Decrypt a `*_sealed` column value straight from the database. */
export function decryptStoredBody(input: {
  masterKeyHex: string
  requestId: string
  stored: Buffer
}): string {
  return decryptBodyRaw({
    masterKeyHex: input.masterKeyHex,
    requestId: input.requestId,
    sealed: unpackSealedBody(input.stored),
  })
}
