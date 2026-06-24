/** Rotas do webhook da Meta WhatsApp Cloud API. */
import type { FastifyInstance } from "fastify";
import { log } from "../logger";
import { metaVerifyToken, metaAppSecret } from "../services/credentials";
import { validSignature } from "./signature";
import { parseIncoming } from "../whatsapp/meta";
import { handleIncoming } from "../pipeline";

export async function registerWebhook(app: FastifyInstance): Promise<void> {
  // Verificação (handshake) — a Meta chama uma vez ao configurar o webhook.
  app.get("/webhook/meta", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const mode = q["hub.mode"];
    const token = q["hub.verify_token"];
    const challenge = q["hub.challenge"];
    const verify = metaVerifyToken();
    if (mode === "subscribe" && token && verify && token === verify) {
      log.info("[webhook] verificação da Meta concluída");
      return reply.code(200).type("text/plain").send(challenge ?? "");
    }
    return reply.code(403).type("text/plain").send("Forbidden");
  });

  // Eventos — sempre responde 200 rápido para a Meta não desativar a assinatura.
  app.post("/webhook/meta", async (req, reply) => {
    const raw = (req as any).rawBody as Buffer | undefined;

    const appSecret = metaAppSecret();
    if (appSecret) {
      const sig = req.headers["x-hub-signature-256"] as string | undefined;
      if (!raw || !validSignature(raw, sig, appSecret)) {
        log.warn("[webhook] assinatura inválida");
        return reply.code(401).send({ ok: false, error: "invalid signature" });
      }
    }

    try {
      const messages = parseIncoming(req.body);
      if (messages.length) {
        void handleIncoming(messages).catch((e) => log.error("[webhook] handleIncoming falhou", e));
      }
    } catch (e) {
      log.error("[webhook] erro ao processar payload", e);
    }
    return reply.code(200).send({ ok: true });
  });
}
