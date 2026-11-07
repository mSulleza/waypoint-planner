// FNV-1a 64-bit over UTF-8 bytes, for CSV row ids only. Four 16-bit limbs keep the multiply exact without BigInt.
export function fnv1a64(text: string): string {
  let h0 = 0x2325
  let h1 = 0x8422
  let h2 = 0x9ce4
  let h3 = 0xcbf2
  const step = (byte: number) => {
    h0 ^= byte
    // prime = 2^40 + 0x1b3, so h × prime = h × 0x1b3 + (h << 40)
    const t0 = h0 * 0x1b3
    const t1 = h1 * 0x1b3 + (t0 >>> 16)
    const t2 = h2 * 0x1b3 + (h0 << 8) + (t1 >>> 16)
    const t3 = h3 * 0x1b3 + (h1 << 8) + (t2 >>> 16)
    h0 = t0 & 0xffff
    h1 = t1 & 0xffff
    h2 = t2 & 0xffff
    h3 = t3 & 0xffff
  }
  for (const ch of text) {
    let c = ch.codePointAt(0) ?? 0
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) step(c)
    else if (c < 0x800) {
      step(0xc0 | (c >> 6))
      step(0x80 | (c & 0x3f))
    } else if (c < 0x10000) {
      step(0xe0 | (c >> 12))
      step(0x80 | ((c >> 6) & 0x3f))
      step(0x80 | (c & 0x3f))
    } else {
      step(0xf0 | (c >> 18))
      step(0x80 | ((c >> 12) & 0x3f))
      step(0x80 | ((c >> 6) & 0x3f))
      step(0x80 | (c & 0x3f))
    }
  }
  return [h3, h2, h1, h0].map((h) => h.toString(16).padStart(4, '0')).join('')
}
