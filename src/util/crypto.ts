/**
 * Cifragem simétrica (AES-256-GCM) para guardar tokens do Google em repouso.
 * Formato de saída: base64(iv).base64(tag).base64(ciphertext)
 */
import crypto from "node:crypto";
import { getEncryptionKey } from "../services/credentials";

function loadKey(): Buffer {
  const raw = getEncryptionKey();
  if (!raw) throw new Error("ENCRYPTION_KEY ausente — necessária para cifrar tokens do Google.");
  // Aceita hex (64 chars) ou base64 (resolve para 32 bytes).
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY deve ter 32 bytes (hex de 64 chars ou base64 equivalente).");
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(payload: string): string {
  const key = loadKey();
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Payload cifrado inválido.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

/** Gera uma chave nova pronta para colar em ENCRYPTION_KEY (uso manual). */
export function generateKeyHex(): string {
  return crypto.randomBytes(32).toString("hex");
}
