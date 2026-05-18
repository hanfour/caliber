import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

// Device API keys (`cda_*` = "caliber device agent") are long-lived secrets
// the daemon presents on every /v1/ingest request. Generation + hashing mirror
// `apiKey.ts` (ak_* keys) — same entropy budget, same HMAC-SHA256 with the
// shared API_KEY_HASH_PEPPER, same constant-time verify. Kept as a separate
// file so the prefix choice is self-documenting and a future rotation of one
// key class doesn't touch the other.

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function toBase62(buf: Buffer): string {
  let out = ''
  let n = BigInt('0x' + buf.toString('hex'))
  const base = BigInt(62)
  while (n > 0n) {
    out = BASE62[Number(n % base)] + out
    n = n / base
  }
  return out || 'A'
}

export function generateDeviceKey(): { raw: string; prefix: string } {
  // randomBytes(48) = 384 bits → ~64 base62 chars; padStart(60) ensures total >= 64 (4 + 60)
  const randomPart = toBase62(randomBytes(48)).padStart(60, 'A')
  const raw = `cda_${randomPart}`
  return { raw, prefix: raw.slice(0, 9) }
}

export function hashDeviceKey(pepperHex: string, raw: string): string {
  if (!/^[0-9a-f]{64}$/i.test(pepperHex)) {
    throw new Error('pepper must be 32 bytes hex (64 chars)')
  }
  return createHmac('sha256', Buffer.from(pepperHex, 'hex')).update(raw).digest('hex')
}

export function verifyDeviceKey(pepperHex: string, raw: string, storedHashHex: string): boolean {
  const candidate = Buffer.from(hashDeviceKey(pepperHex, raw), 'hex')
  const stored = Buffer.from(storedHashHex, 'hex')
  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}
