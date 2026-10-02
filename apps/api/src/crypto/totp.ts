/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — no external deps. */
import { createHmac, randomBytes } from "node:crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0,out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/,"").replace(/\s/g,"");
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

export function newTotpSecret(): string { return base32Encode(randomBytes(20)); }

export function totpCode(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = digest[digest.length - 1] & 0xf;
  const code = ((digest[off] & 0x7f) << 24 | digest[off+1] << 16 | digest[off+2] << 8 | digest[off+3]) % 1_000_000;
  return String(code).padStart(6, "0");
}

/**
 * Returns the matched time-step counter, or -1 when no code in the window
 * matches. The caller persists the counter (users.mfa_last_counter) and
 * rejects any counter <= the stored one — replay protection.
 */
export function verifyTotpCounter(secret: string, code: string, atMs: number = Date.now(), window = 1): number {
  for (let w = -window; w <= window; w++) {
    const stepMs = atMs + w * 30_000;
    if (totpCode(secret, stepMs) === code) return Math.floor(stepMs / 1000 / 30);
  }
  return -1;
}

export function verifyTotp(secret: string, code: string, atMs: number = Date.now(), window = 1): boolean {
  return verifyTotpCounter(secret, code, atMs, window) >= 0;
}
