/** Monta a aplicação Fastify (parser de corpo cru + rotas). */
import Fastify, { type FastifyInstance } from "fastify";
import { registerWebhook } from "./webhook";
import { registerOAuth } from "./oauth";
import { registerPanel } from "./panel";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  // Captura o corpo cru (necessário para validar a assinatura da Meta) e
  // ainda assim entrega o JSON parseado em req.body.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body: Buffer, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body.toString("utf8")) : {});
    } catch {
      done(null, {}); // não derruba o webhook por JSON malformado
    }
  });

  app.get("/", async () => ({ service: "secretario", status: "ok" }));
  app.get("/health", async () => ({ ok: true }));

  await registerWebhook(app);
  await registerOAuth(app);
  await registerPanel(app);

  return app;
}
