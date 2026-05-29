import { encryptAesGcm, decryptAesGcm, type Sealed } from './aesGcmHkdf.js'

export type SealedCredential = Sealed

const CREDENTIAL_INFO = Buffer.from('caliber-gateway-credential-v2', 'utf8')

interface EncryptInput {
  masterKeyHex: string
  accountId: string
  plaintext: string
}

interface DecryptInput {
  masterKeyHex: string
  accountId: string
  sealed: SealedCredential
}

export function encryptCredential(input: EncryptInput): SealedCredential {
  return encryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: CREDENTIAL_INFO,
    salt: input.accountId,
    plaintext: input.plaintext,
  })
}

export function decryptCredential(input: DecryptInput): string {
  return decryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: CREDENTIAL_INFO,
    salt: input.accountId,
    sealed: input.sealed,
  })
}
