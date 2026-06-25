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
import { composeProactive, composeWithSearch } from "../brain/secretary";
import { todayKey, TZ } from "../util/datetime";

const DEFAULT_JOB_BRIEF =
  "Vagas 100% remotas que aceitem candidatos morando no Brasil, remuneração a partir de ~R$5.000/mês (ou equivalente em USD/EUR), que aceitem ou exijam inglês.";

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

/** Executa a busca de vagas e entrega o resultado. Compartilhada (auto + manual). */
async function doJobSearch(): Promise<void> {
  const brief = (await getSetting("jobSearchBrief")) || DEFAULT_JOB_BRIEF;
  const text = await composeWithSearch(
    `Hora da busca de vagas para ${config.OWNER_NAME}. ` +
      `Critérios: ${brief} ` +
      `Use a busca na web para encontrar vagas REAIS e recentes — não invente nem reaproveite vagas antigas. ` +
      `Leve em conta o perfil profissional dele que estiver na memória/contexto. ` +
      `Escolha as 3 a 5 melhores e, para cada uma, traga: cargo e empresa, faixa salarial (se houver), por que combina com ele, e o LINK direto para se candidatar. ` +
      `Se hoje não houver nada que realmente valha a pena, seja honesto e diga isso em uma linha — melhor pouco e bom do que encher de vaga ruim. ` +
      `Texto enxuto, tom de secretário, sem markdown pesado.`,
  );
  if (text.trim()) await sendProactive(`💼 Vagas\n\n${text}`);
}

/** Busca diária de vagas (agendada): roda uma vez por dia. */
async function runJobSearch(): Promise<void> {
  if (!canSend() || !anthropicReady()) return;
  const today = todayKey();
  if ((await getSetting("lastJobSearch")) === today) return; // já rodou hoje
  await setSetting("lastJobSearch", today); // marca cedo (evita corrida entre réplicas)
  try {
    await doJobSearch();
    log.info("[cron] busca diária de vagas enviada");
  } catch (e) {
    log.error("[cron] falha na busca diária de vagas", e);
  }
}

/** Dispara a busca de vagas sob demanda (botão do painel), ignorando o dedupe diário. */
export async function runJobSearchNow(): Promise<void> {
  if (!anthropicReady()) throw new Error("Claude não configurado.");
  if (!canSend()) throw new Error("Conecte o Telegram ou o WhatsApp para receber as vagas.");
  await doJobSearch();
}

/** Converte "HH:MM" em expressão cron "M H * * *". null se inválido/vazio. */
function hmCronExpr(time: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time || "").trim());
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
  const expr = hmCronExpr(config.BRIEFING_TIME);
  if (expr) {
    cron.schedule(expr, () => void sendDailyBriefing(), { timezone: TZ });
    log.info(`[cron] briefing diário agendado para ${config.BRIEFING_TIME} (${TZ})`);
  } else {
    log.info("[cron] briefing diário desativado (BRIEFING_TIME vazio/inválido)");
  }

  // Busca diária de vagas.
  const jobExpr = hmCronExpr(config.JOB_SEARCH_TIME);
  if (jobExpr) {
    cron.schedule(jobExpr, () => void runJobSearch(), { timezone: TZ });
    log.info(`[cron] busca de vagas agendada para ${config.JOB_SEARCH_TIME} (${TZ})`);
  } else {
    log.info("[cron] busca de vagas desativada (JOB_SEARCH_TIME vazio/inválido)");
  }
}
