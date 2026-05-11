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
