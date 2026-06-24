/**
 * OAuth do Google (Calendar). Tokens guardados cifrados no banco (GoogleToken).
 * O googleapis renova o access_token sozinho quando há refresh_token; persistimos
 * a cada renovação via evento 'tokens'.
 */
import { google } from "googleapis";
import { cred, googleReady } from "./credentials";
import { config } from "../config";
import { prisma } from "../db";
import { encrypt, decrypt } from "../util/crypto";
import { log } from "../logger";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];
const TOKEN_ID = "owner";

/** Redirect URI: lê da env (override manual) ou computa a partir da PUBLIC_URL. */
function redirectUri(): string {
  return config.GOOGLE_REDIRECT_URI || (config.PUBLIC_URL ? config.PUBLIC_URL + "/oauth/google/callback" : "");
}

/** Cliente OAuth2 base (sem credenciais). null se o Google não está configurado. */
function baseClient() {
  if (!googleReady()) return null;
  return new google.auth.OAuth2(
    cred("GOOGLE_CLIENT_ID"),
    cred("GOOGLE_CLIENT_SECRET"),
    redirectUri(),
  );
}

/** URL de consentimento (offline + prompt consent para garantir refresh_token). */
export function buildAuthUrl(state: string): string | null {
  const client = baseClient();
  if (!client) return null;
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

/** Troca o `code` por tokens e os persiste cifrados. */
export async function exchangeCode(code: string): Promise<void> {
  const client = baseClient();
  if (!client) throw new Error("Google não configurado.");
  const { tokens } = await client.getToken(code);
  await saveCredentials(tokens);
}

async function saveCredentials(creds: Record<string, any>): Promise<void> {
  // Mescla com o que já existe (refresh_token pode não vir em renovações).
  const existing = await loadCredentials();
  const merged = { ...(existing ?? {}), ...creds };
  await prisma.googleToken.upsert({
    where: { id: TOKEN_ID },
    update: { data: encrypt(JSON.stringify(merged)) },
    create: { id: TOKEN_ID, data: encrypt(JSON.stringify(merged)) },
  });
}

async function loadCredentials(): Promise<Record<string, any> | null> {
  const row = await prisma.googleToken.findUnique({ where: { id: TOKEN_ID } });
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.data));
  } catch (e) {
    log.error("[google] falha ao decifrar tokens", e);
    return null;
  }
}

/** Cliente OAuth2 autenticado e pronto, ou null se a agenda não foi conectada. */
export async function authedClient() {
  const client = baseClient();
  if (!client) return null;
  const creds = await loadCredentials();
  if (!creds || !creds.refresh_token) return null;
  client.setCredentials(creds);
  client.on("tokens", (tokens) => {
    void saveCredentials(tokens);
  });
  return client;
}

export async function isConnected(): Promise<boolean> {
  const creds = await loadCredentials();
  return Boolean(creds?.refresh_token);
}
