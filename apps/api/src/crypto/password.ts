import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";

const N = 32768;

function scryptAsync(pw: string, salt: Buffer, len: number, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pw, salt, len, { N: n, maxmem: 128 * n * 8 * 2 }, (err, derived) => err ? reject(err) : resolve(derived as Buffer)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const buf = await scryptAsync(password, salt, 64, N);
  return `scrypt$${N}$${salt.toString("base64")}$${buf.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, nStr, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt") return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password, salt, expected.length, Number(nStr));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class PasswordPolicyError extends Error {
  constructor(public detail: string) { super(detail); this.name = "PasswordPolicyError"; }
}

const WEAK = new Set([
  "passw0rd!", "password", "password1", "password123", "changeme", "letmein",
  "qwerty123456", "schoolportal", "welcome123", "admin1234567",
]);

/** Minimum acceptable password for bootstrap admin, reset, change, and invites. */
export function assertPasswordPolicy(pw: string): void {
  if (typeof pw !== "string" || pw.length < 12) {
    throw new PasswordPolicyError("password must be at least 12 characters");
  }
  if (pw.length > 200) throw new PasswordPolicyError("password must be at most 200 characters");
  if (WEAK.has(pw.toLowerCase())) throw new PasswordPolicyError("password is too common");
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    throw new PasswordPolicyError("password must mix upper-case, lower-case and digits");
  }
}
