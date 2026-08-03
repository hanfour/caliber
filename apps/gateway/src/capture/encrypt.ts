import {
  encryptBodyRaw,
  decryptStoredBody,
  packSealedBody,
} from '@caliber/gateway-core'

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

export interface EncryptBodyResult {
  sealed: Buffer
}

export function encryptBody(input: EncryptBodyInput): EncryptBodyResult {
  return { sealed: packSealedBody(encryptBodyRaw(input)) }
}

export function decryptBody(input: DecryptBodyInput): string {
  return decryptStoredBody({
    masterKeyHex: input.masterKeyHex,
    requestId: input.requestId,
    stored: input.sealed,
  })
}
