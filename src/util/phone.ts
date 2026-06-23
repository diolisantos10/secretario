/** Normalização e allow-list de telefone. O serviço só atende o dono. */
import { config } from "../config";

/** Mantém apenas os dígitos. */
export function digits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/**
 * É o dono? Compara dígitos; tolera variações de código de país e o 9º dígito
 * brasileiro comparando os últimos 8 dígitos como fallback.
 */
export function isOwner(from: string | null | undefined): boolean {
  const a = digits(from);
  const b = digits(config.OWNER_WHATSAPP);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.slice(-8) === b.slice(-8);
}

/** Número do dono em formato de envio (só dígitos). */
export function ownerNumber(): string {
  return digits(config.OWNER_WHATSAPP);
}
