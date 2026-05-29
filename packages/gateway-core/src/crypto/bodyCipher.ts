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
