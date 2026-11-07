// A random v4 uuid for a new row or batch. Browsers give crypto.randomUUID only on HTTPS and localhost, so a plain-HTTP address builds one from getRandomValues; uuid.native.ts uses expo-crypto on phones.
export const randomId = (): string => (typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID() : uuidOf(globalThis.crypto.getRandomValues(new Uint8Array(16))))

// RFC 9562 version 4: sixteen random bytes with the version and variant bits set.
export function uuidOf(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes)
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
