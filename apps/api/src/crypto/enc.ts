/** AES-256-GCM envelope for small secrets (TOTP keys). Production uses KMS-backed DEKs (ADR-005). */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config";

const key = createHash("sha256").update(config.appSecret).digest();

export function encryptText(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}

export function decryptText(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(dataB64, "base64")), d.final()]).toString("utf8");
}
