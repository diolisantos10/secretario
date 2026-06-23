/** Helpers de data/hora no fuso do dono. */
import { formatInTimeZone } from "date-fns-tz";
import { ptBR } from "date-fns/locale";
import { config } from "../config";

const TZ = config.TIMEZONE;
const LOCALE = { locale: ptBR };

/** Agora, legível em português, no fuso configurado. Ex.: "segunda-feira, 23/06/2026 14:35". */
export function nowHuman(): string {
  return formatInTimeZone(new Date(), TZ, "EEEE, dd/MM/yyyy HH:mm", LOCALE);
}

/** Agora em ISO 8601 com offset do fuso. Ex.: "2026-06-23T14:35:00-03:00". */
export function nowIso(): string {
  return formatInTimeZone(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** Formata uma data para exibição curta no fuso. Ex.: "23/06 14:35". */
export function fmtShort(date: Date): string {
  return formatInTimeZone(date, TZ, "dd/MM HH:mm");
}

/** Formata uma data por extenso no fuso. */
export function fmtLong(date: Date): string {
  return formatInTimeZone(date, TZ, "EEEE, dd/MM/yyyy 'às' HH:mm", LOCALE);
}

/** "YYYY-MM-DD" de hoje no fuso (chave para deduplicar o briefing diário). */
export function todayKey(): string {
  return formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
}

/** Intervalo [início, fim] do dia de hoje, em Date UTC, segundo o fuso. */
export function todayBounds(): { start: Date; end: Date } {
  const startIso = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd'T'00:00:00XXX");
  const endIso = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd'T'23:59:59XXX");
  return { start: new Date(startIso), end: new Date(endIso) };
}

export { TZ };
