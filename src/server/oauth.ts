/** Rotas de OAuth do Google Calendar (conectar a agenda uma única vez). */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
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

/** Deriva a redirect URI a partir dos headers da requisição (funciona atrás de proxy/Railway). */
function deriveRedirectUri(req: FastifyRequest): string {
  const proto = ((req.headers["x-forwarded-proto"] as string) || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] as string) || req.hostname;
  return `${proto}://${host}/oauth/google/callback`;
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
        .send(page("Google não configurado", "Configure o Client ID e o Client Secret no painel do secretário."));
    }
    const state = crypto.randomBytes(16).toString("hex");
    await setSetting("googleOAuthState", state);
    const callbackUri = deriveRedirectUri(req);
    await setSetting("googleOAuthRedirectUri", callbackUri);
    const url = buildAuthUrl(state, callbackUri);
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
      const callbackUri = await getSetting("googleOAuthRedirectUri") || deriveRedirectUri(req);
      await exchangeCode(code, callbackUri);
      await setSetting("googleOAuthState", "");
      log.info("[oauth] Google conectado");
      return reply.redirect("/painel?p=integrations&ok=google");
    } catch (e) {
      log.error("[oauth] troca de código falhou", e);
      return reply.code(500).type("text/html").send(page("Erro ao conectar", "Não consegui finalizar a autorização. Tente novamente."));
    }
  });
}
