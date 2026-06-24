/**
 * Agendador: dá proatividade ao secretário.
 * - A cada minuto: dispara lembretes vencidos.
 * - Uma vez por dia (BRIEFING_TIME): envia o resumo matinal.
 */
import cron from "node-cron";
import { config } from "../config";
import { anthropicReady } from "../services/credentials";
import { canSendWhatsApp } from "../whatsapp/channel";
import { telegramConnected } from "../whatsapp/telegram";
import { log } from "../logger";
import { prisma } from "../db";
import { dueReminders, markSent } from "../services/reminders";
import { sendProactive } from "../pipeline";
import { composeProactive } from "../brain/secretary";
import { todayKey, TZ } from "../util/datetime";

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}
async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

/** Há algum canal (Telegram ou WhatsApp) pronto para enviar? */
function canSend(): boolean {
  return telegramConnected() || canSendWhatsApp();
}

/** Dispara lembretes vencidos. */
async function dispatchDueReminders(): Promise<void> {
  if (!canSend()) return;
  const due = await dueReminders();
  for (const r of due) {
    try {
      await sendProactive(`⏰ Lembrete: ${r.text}`);
      await markSent(r.id);
    } catch (e) {
      log.error(`[cron] falha ao disparar lembrete ${r.id}`, e);
    }
  }
}

/** Envia o briefing matinal (uma vez por dia). */
async function sendDailyBriefing(): Promise<void> {
  if (!canSend() || !anthropicReady()) return;
  const today = todayKey();
  if ((await getSetting("lastBriefing")) === today) return; // já enviado hoje
  try {
    const text = await composeProactive(
      `Gere um bom-dia curto e útil para ${config.OWNER_NAME}: cumprimente, liste a agenda de hoje e os lembretes/pendências mais importantes do contexto, e finalize com uma frase de foco. Sem markdown pesado, tom de secretário.`,
    );
    await sendProactive(text);
    await setSetting("lastBriefing", today);
    log.info("[cron] briefing diário enviado");
  } catch (e) {
    log.error("[cron] falha no briefing diário", e);
  }
}

/** Converte "HH:MM" em expressão cron "M H * * *". null se inválido/vazio. */
function briefingCronExpr(): string | null {
  const t = (config.BRIEFING_TIME || "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const hour = Number(m[1]);
  const min = Number(m[2]);
  if (hour > 23 || min > 59) return null;
  return `${min} ${hour} * * *`;
}

export function startScheduler(): void {
  // Lembretes: a cada minuto.
  cron.schedule("* * * * *", () => void dispatchDueReminders(), { timezone: TZ });
  log.info("[cron] verificação de lembretes a cada minuto ativada");

  // Briefing diário.
  const expr = briefingCronExpr();
  if (expr) {
    cron.schedule(expr, () => void sendDailyBriefing(), { timezone: TZ });
    log.info(`[cron] briefing diário agendado para ${config.BRIEFING_TIME} (${TZ})`);
  } else {
    log.info("[cron] briefing diário desativado (BRIEFING_TIME vazio/inválido)");
  }
}
