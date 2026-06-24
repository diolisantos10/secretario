/**
 * Credenciais dinâmicas — a "regra de ouro" do projeto.
 *
 * Toda integração (Google, WhatsApp) é configurada pelo PAINEL, não por código
 * nem por variáveis do Railway. Os valores ficam na tabela Setting (prefixo
 * `cred:`) e são lidos daqui. Variáveis de ambiente continuam funcionando como
 * fallback — se já estiver no ambiente, vale; senão, vale o que está no banco.
 *
 * Um cache em memória é hidratado no boot (hydrateCredentials) para que os
 * pontos de uso síncronos (envio Meta, cifragem) continuem simples.
 */
import crypto from "node:crypto";
import { config } from "../config";
import { prisma } from "../db";
import { log } from "../logger";

const PREFIX = "cred:";

/** Chaves que o painel pode gravar. */
const MANAGED = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "ENCRYPTION_KEY",
  "META_PHONE_NUMBER_ID",
  "META_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "META_GRAPH_VERSION",
  "OWNER_WHATSAPP",
] as const;
export type CredKey = (typeof MANAGED)[number];

const cache: Record<string, string> = {};

function envFallback(key: string): string {
  const v = (config as any)[key];
  return typeof v === "string" ? v : "";
}

/** Valor efetivo: banco (cache) tem prioridade; senão, variável de ambiente. */
export function cred(key: CredKey | string): string {
  const c = cache[key];
  if (c && c.length) return c;
  return envFallback(key);
}

/** Carrega do banco para o cache e garante uma ENCRYPTION_KEY. Chamar no boot. */
export async function hydrateCredentials(): Promise<void> {
  try {
    const rows = await prisma.setting.findMany({ where: { key: { startsWith: PREFIX } } });
    for (const r of rows) cache[r.key.slice(PREFIX.length)] = r.value;
  } catch (e) {
    log.error("[credentials] falha ao carregar do banco", e);
  }
  // Sem chave de cifragem? Gera uma e persiste — assim o Google funciona sem o
  // dono precisar mexer em nada (env tem prioridade se já estiver definida).
  if (!cred("ENCRYPTION_KEY")) {
    await setCredentials({ ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex") });
    log.info("[credentials] ENCRYPTION_KEY gerada automaticamente e salva no banco");
  }
}

/** Grava credenciais no banco e atualiza o cache. */
export async function setCredentials(values: Partial<Record<CredKey, string>>): Promise<void> {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    const val = String(v).trim();
    cache[k] = val;
    await prisma.setting.upsert({
      where: { key: PREFIX + k },
      update: { value: val },
      create: { key: PREFIX + k, value: val },
    });
  }
}

/** Chave de cifragem (para crypto.ts). */
export function getEncryptionKey(): string {
  return cred("ENCRYPTION_KEY");
}

/** Google Calendar tem as credenciais de app necessárias? */
export function googleReady(): boolean {
  return Boolean(cred("GOOGLE_CLIENT_ID") && cred("GOOGLE_CLIENT_SECRET") && cred("GOOGLE_REDIRECT_URI"));
}

/** WhatsApp (Meta) pronto para enviar/receber? */
export function metaReady(): boolean {
  return Boolean(cred("META_PHONE_NUMBER_ID") && cred("META_ACCESS_TOKEN"));
}

export function metaVerifyToken(): string {
  return cred("META_VERIFY_TOKEN");
}
export function metaAppSecret(): string {
  return cred("META_APP_SECRET");
}

/** Credenciais Meta exigidas no ponto de envio. Lança erro amigável se faltarem. */
export function requireMeta() {
  const phoneNumberId = cred("META_PHONE_NUMBER_ID");
  const accessToken = cred("META_ACCESS_TOKEN");
  if (!phoneNumberId || !accessToken) {
    throw new Error(
      "WhatsApp não configurado — preencha o Phone Number ID e o Access Token na página de integrações do painel.",
    );
  }
  return { phoneNumberId, accessToken, graphVersion: cred("META_GRAPH_VERSION") || "v21.0" };
}
