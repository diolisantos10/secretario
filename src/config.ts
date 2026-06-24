/**
 * Configuração central — lê e valida variáveis de ambiente.
 *
 * Filosofia: só DATABASE_URL é obrigatória para o serviço subir. Tudo o que
 * depende de credenciais do dono (Anthropic, Meta, Google) é opcional aqui e
 * validado "preguiçosamente" no ponto de uso, com erro claro. Assim o serviço
 * sobe e o webhook responde à verificação da Meta mesmo antes de você plugar
 * todas as chaves — a sua parte fica realmente por último.
 */
import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  // Infra
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),
  PORT: z.coerce.number().default(8080),
  PUBLIC_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Senha do painel web (/painel). Se vazia, o painel fica desativado.
  PANEL_PASSWORD: z.string().optional(),

  // Dono / preferências
  OWNER_WHATSAPP: z.string().optional(), // número internacional só dígitos, ex: 5511999999999
  OWNER_NAME: z.string().default("chefe"),
  TIMEZONE: z.string().default("America/Sao_Paulo"),
  BRIEFING_TIME: z.string().default("07:30"), // HH:MM no fuso acima; vazio desliga

  // OpenAI (geração de imagens com DALL-E 3)
  OPENAI_API_KEY: z.string().optional(),

  // Claude (Anthropic)
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  ENABLE_WEB_SEARCH: z.coerce.boolean().default(true),

  // Meta WhatsApp Cloud API
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_GRAPH_VERSION: z.string().default("v21.0"),

  // Cifragem dos tokens do Google (32 bytes em hex[64] ou base64)
  ENCRYPTION_KEY: z.string().optional(),

  // Google Calendar (OAuth)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  // eslint-disable-next-line no-console
  console.error(`\n[config] Variáveis de ambiente inválidas:\n${issues}\n`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

/** Pronto para enviar/receber no WhatsApp? */
export function metaReady(): boolean {
  return Boolean(config.META_PHONE_NUMBER_ID && config.META_ACCESS_TOKEN);
}

/** Pronto para pensar (Claude)? */
export function anthropicReady(): boolean {
  return Boolean(config.ANTHROPIC_API_KEY);
}

/** Painel web habilitado? (precisa de uma senha definida). */
export function panelReady(): boolean {
  return Boolean(config.PANEL_PASSWORD);
}

/** Pronto para gerar imagens (DALL-E 3)? */
export function openaiReady(): boolean {
  return Boolean(config.OPENAI_API_KEY);
}

/** Pronto para a agenda (Google Calendar)? */
export function googleReady(): boolean {
  return Boolean(
    config.GOOGLE_CLIENT_ID &&
      config.GOOGLE_CLIENT_SECRET &&
      config.GOOGLE_REDIRECT_URI &&
      config.ENCRYPTION_KEY,
  );
}

/** Credenciais Meta exigidas no ponto de envio. Lança erro amigável se faltarem. */
export function requireMeta() {
  if (!config.META_PHONE_NUMBER_ID || !config.META_ACCESS_TOKEN) {
    throw new Error(
      "WhatsApp Meta não configurado — defina META_PHONE_NUMBER_ID e META_ACCESS_TOKEN.",
    );
  }
  return {
    phoneNumberId: config.META_PHONE_NUMBER_ID,
    accessToken: config.META_ACCESS_TOKEN,
    graphVersion: config.META_GRAPH_VERSION,
  };
}
