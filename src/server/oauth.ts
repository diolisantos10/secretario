/** Rotas de OAuth do Google Calendar (conectar a agenda uma única vez). */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { googleReady } from "../services/credentials";
import { log } from "../logger";
import { prisma } from "../db";
import { buildAuthUrl, exchangeCode } from "../services/googleAuth";

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}
async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<div style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 24px;text-align:center">
<h2>${title}</h2><p style="color:#444;line-height:1.5">${body}</p></div>`;
}

export async function registerOAuth(app: FastifyInstance): Promise<void> {
  app.get("/oauth/google/start", async (req, reply) => {
    if (!googleReady()) {
      return reply
        .code(503)
        .type("text/html")
        .send(page("Agenda não configurada", "Faltam as credenciais do Google. Preencha o Client ID e o Client Secret na página de integrações do painel."));
    }
    const state = crypto.randomBytes(16).toString("hex");
    await setSetting("googleOAuthState", state);
    const url = buildAuthUrl(state);
    if (!url) return reply.code(503).type("text/html").send(page("Indisponível", "Não foi possível gerar o link de autorização."));
    return reply.redirect(url);
  });

  app.get("/oauth/google/callback", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const code = q.code;
    const state = q.state;
    const saved = await getSetting("googleOAuthState");
    if (!code || !state || !saved || state !== saved) {
      return reply.code(400).type("text/html").send(page("Falha na verificação", "O parâmetro de segurança (state) não confere. Tente abrir o link novamente."));
    }
    try {
      await exchangeCode(code);
      await setSetting("googleOAuthState", "");
      log.info("[oauth] Google Calendar conectado");
      return reply.type("text/html").send(page("Agenda conectada ✅", "Pode fechar esta aba. Seu secretário já consegue ver e criar eventos."));
    } catch (e) {
      log.error("[oauth] troca de código falhou", e);
      return reply.code(500).type("text/html").send(page("Erro ao conectar", "Não consegui finalizar a autorização. Tente novamente."));
    }
  });
}
