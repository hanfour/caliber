import { encryptBodyRaw, decryptBodyRaw } from '@caliber/gateway-core'

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
}

export function encryptBody(input: EncryptBodyInput): Buffer {
  const { nonce, ciphertext, authTag } = encryptBodyRaw(input)
  return Buffer.concat([nonce, ciphertext, authTag])
}

export function decryptBody(input: DecryptBodyInput): string {
  const { sealed, masterKeyHex, requestId } = input
  if (sealed.length < NONCE_LEN + TAG_LEN) {
    throw new Error('sealed buffer too small')
  }
  const nonce = sealed.subarray(0, NONCE_LEN)
  const authTag = sealed.subarray(sealed.length - TAG_LEN)
  const ciphertext = sealed.subarray(NONCE_LEN, sealed.length - TAG_LEN)
  return decryptBodyRaw({ masterKeyHex, requestId, sealed: { nonce, ciphertext, authTag } })
}
