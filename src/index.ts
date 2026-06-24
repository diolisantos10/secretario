/** Ponto de entrada: sobe o servidor e o agendador. */
import { config, anthropicReady, panelReady, openaiReady } from "./config";
import { metaReady, googleReady, hydrateCredentials } from "./services/credentials";
import { log } from "./logger";
import { prisma } from "./db";
import { buildApp } from "./server/app";
import { startScheduler } from "./scheduler/cron";
import { handleIncoming } from "./pipeline";
import { setMessageHandler, maybeAutoStartWhatsApp, waConnected } from "./whatsapp/baileys";

function readiness(): void {
  const mark = (ok: boolean) => (ok ? "✅" : "⚠️  faltando");
  log.info("=== Secretário — prontidão ===");
  log.info(`Banco de dados ........ ✅`);
  log.info(`Claude (Anthropic) .... ${mark(anthropicReady())}`);
  log.info(`WhatsApp (QR/Baileys) . ${waConnected() ? "✅ conectado" : "⚠️  conecte pelo painel (QR)"}`);
  log.info(`WhatsApp (Meta, opc.) . ${mark(metaReady())}`);
  log.info(`Allow-list (dono) ..... ${mark(Boolean(config.OWNER_WHATSAPP))}`);
  log.info(`Agenda (Google) ....... ${mark(googleReady())}`);
  log.info(`Imagens (OpenAI) ...... ${mark(openaiReady())}`);
  log.info(`Painel web (/painel) .. ${mark(panelReady())}`);
  log.info("==============================");
  if (panelReady() && config.PUBLIC_URL) {
    log.info(`Painel disponível em ${config.PUBLIC_URL}/painel`);
  }
  if (!anthropicReady() || (!waConnected() && !metaReady()) || !config.OWNER_WHATSAPP) {
    log.warn("Itens faltando são a sua parte (conectar o WhatsApp pelo QR no painel). O serviço sobe normalmente.");
  }
}

async function main(): Promise<void> {
  await prisma.$connect();
  await hydrateCredentials(); // carrega credenciais do banco (painel) p/ o cache

  // WhatsApp via QR: liga o roteamento de mensagens e reconecta se já houver sessão.
  setMessageHandler((msgs) => void handleIncoming(msgs));
  await maybeAutoStartWhatsApp();

  readiness();

  const app = await buildApp();
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  log.info(`[http] ouvindo em 0.0.0.0:${config.PORT}`);

  startScheduler();

  const shutdown = async (sig: string) => {
    log.info(`[shutdown] sinal ${sig} — encerrando...`);
    try {
      await app.close();
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("[fatal] falha ao iniciar", e);
  process.exit(1);
});
