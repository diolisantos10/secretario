/**
 * WhatsApp via Baileys — login por QR Code (protocolo do WhatsApp Web).
 *
 * Diferente da Meta Cloud API, aqui o secretário age como um "aparelho conectado":
 * o dono escaneia um QR Code uma única vez (WhatsApp > Aparelhos conectados) e pronto,
 * sem criar app na Meta, sem token, sem webhook. A sessão (auth state) é guardada no
 * Postgres (tabela WaAuth), então o serviço reconecta sozinho após reinícios — não
 * precisa reescanear.
 *
 * Nota: é o protocolo não-oficial do WhatsApp Web, o mesmo que todos os bots de QR Code
 * usam. Pensado para uso pessoal, no próprio número do dono.
 */
import makeWASocket, {
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser,
  proto,
  type WASocket,
  type WAMessage,
  type AuthenticationCreds,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import { prisma } from "../db";
import { log } from "../logger";
import { cred, setCredentials } from "../services/credentials";
import type { IncomingMessage } from "./meta";

const logger = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Auth state persistente no Postgres (tabela WaAuth)
// ---------------------------------------------------------------------------

async function dbRead(key: string): Promise<any> {
  const row = await prisma.waAuth.findUnique({ where: { key } });
  if (!row) return null;
  return JSON.parse(row.value, BufferJSON.reviver);
}
async function dbWrite(key: string, value: unknown): Promise<void> {
  const val = JSON.stringify(value, BufferJSON.replacer);
  await prisma.waAuth.upsert({ where: { key }, update: { value: val }, create: { key, value: val } });
}
async function dbDelete(key: string): Promise<void> {
  await prisma.waAuth.delete({ where: { key } }).catch(() => {});
}
async function clearAuth(): Promise<void> {
  await prisma.waAuth.deleteMany({}).catch(() => {});
}

async function usePrismaAuthState() {
  const creds: AuthenticationCreds = (await dbRead("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const data: Record<string, any> = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await dbRead(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data: Record<string, Record<string, any>>) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? dbWrite(key, value) : dbDelete(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => dbWrite("creds", creds),
  };
}

// ---------------------------------------------------------------------------
// Conexão (ciclo de vida) + estado exposto ao painel
// ---------------------------------------------------------------------------

export type WaState = "idle" | "connecting" | "qr" | "open";

let sock: WASocket | null = null;
let connState: WaState = "idle";
let qrDataUrl: string | null = null;
let starting = false;
let onMessage: ((msgs: IncomingMessage[]) => void) | null = null;

// IDs das mensagens que NÓS enviamos — para não reprocessar o eco do próprio envio
// (essencial no modo "conversa com você mesmo", em que o dono usa o próprio número).
const sentIds = new Set<string>();
function rememberSent(id: string | null | undefined): void {
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > 300) {
    // mantém o conjunto pequeno: descarta os mais antigos
    const first = sentIds.values().next().value;
    if (first) sentIds.delete(first);
  }
}

/** Quem recebe as mensagens normalizadas (definido pelo index, evita ciclo de import). */
export function setMessageHandler(fn: (msgs: IncomingMessage[]) => void): void {
  onMessage = fn;
}

/** Estado atual para o painel: idle | connecting | qr | open (+ QR e número). */
export function waStatus(): { state: WaState; qr: string | null; me: string | null } {
  let me: string | null = null;
  try {
    me = sock?.user?.id ? jidNormalizedUser(sock.user.id).split("@")[0] : null;
  } catch {
    me = null;
  }
  return { state: connState, qr: connState === "qr" ? qrDataUrl : null, me };
}

export function waConnected(): boolean {
  return connState === "open";
}

/** Sobe o socket (idempotente). A conexão evolui pelos eventos. */
export async function startWhatsApp(): Promise<void> {
  if (sock || starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await usePrismaAuthState();
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined; // usa o default embutido na lib
    }
    connState = "connecting";
    qrDataUrl = null;

    sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: ["Secretário", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", () => void saveCreds());

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        connState = "qr";
        try {
          qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        } catch {
          qrDataUrl = null;
        }
        log.info("[whatsapp] QR Code gerado — escaneie pelo painel");
      }
      if (connection === "open") {
        connState = "open";
        qrDataUrl = null;
        log.info(`[whatsapp] conectado como ${sock?.user?.id ?? "?"}`);
        // Modo "número pessoal": se o dono ainda não escolheu quem pode falar com
        // o secretário, assume o próprio número conectado — assim a "conversa com
        // você mesmo" já funciona sem nenhum passo extra.
        try {
          if (!cred("OWNER_WHATSAPP") && sock?.user?.id) {
            const me = jidNormalizedUser(sock.user.id).split("@")[0].replace(/\D/g, "");
            if (me) {
              await setCredentials({ OWNER_WHATSAPP: me });
              log.info(`[whatsapp] dono definido automaticamente: ${me}`);
            }
          }
        } catch (e) {
          log.error("[whatsapp] falha ao autodefinir o dono", e);
        }
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        sock = null;
        if (code === DisconnectReason.loggedOut) {
          connState = "idle";
          qrDataUrl = null;
          await clearAuth();
          log.warn("[whatsapp] sessão encerrada (logout) — será preciso reescanear");
        } else {
          connState = "connecting";
          log.warn(`[whatsapp] conexão caiu (code ${code ?? "?"}) — reconectando em 2s...`);
          setTimeout(() => void startWhatsApp(), 2000);
        }
      }
    });

    sock.ev.on("messages.upsert", async (ev) => {
      if (ev.type !== "notify") return;
      const out: IncomingMessage[] = [];
      for (const msg of ev.messages) {
        const im = await toIncoming(msg);
        if (im) out.push(im);
      }
      if (out.length && onMessage) onMessage(out);
    });
  } catch (e) {
    connState = "idle";
    sock = null;
    log.error("[whatsapp] falha ao iniciar", e);
  } finally {
    starting = false;
  }
}

/** Desconecta e apaga a sessão (o dono terá que reescanear para reconectar). */
export async function logoutWhatsApp(): Promise<void> {
  try {
    await sock?.logout();
  } catch {
    /* ignore */
  }
  sock = null;
  connState = "idle";
  qrDataUrl = null;
  await clearAuth();
  log.info("[whatsapp] desconectado e sessão apagada");
}

/** No boot: se já existe sessão salva, reconecta sozinho (sem reescanear). */
export async function maybeAutoStartWhatsApp(): Promise<void> {
  const has = await prisma.waAuth.findUnique({ where: { key: "creds" } }).catch(() => null);
  if (has) {
    log.info("[whatsapp] sessão encontrada no banco — reconectando...");
    void startWhatsApp();
  }
}

// ---------------------------------------------------------------------------
// Normalização de entrada + envio
// ---------------------------------------------------------------------------

async function toIncoming(msg: WAMessage): Promise<IncomingMessage | null> {
  const key = msg.key;
  if (!msg.message || !key) return null;
  // fromMe=true acontece em dois casos: (a) eco de uma resposta NOSSA -> ignorar;
  // (b) o dono escrevendo na "conversa com você mesmo" -> tratar como entrada do dono.
  if (key.fromMe && sentIds.has(key.id || "")) return null;
  const jid = key.remoteJid || "";
  // Ignora grupos, status e canais — só conversa 1:1.
  if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us") || jid.endsWith("@newsletter")) return null;

  const from = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
  const waMessageId = key.id || "";
  const tsSec = Number(msg.messageTimestamp || 0);
  const timestamp = tsSec ? new Date(tsSec * 1000) : new Date();
  const profileName = msg.pushName || null;

  // Marca como lida aqui (temos a key completa).
  if (sock) void sock.readMessages([key]).catch(() => {});

  const m = msg.message;
  const audio = m.audioMessage;
  if (audio) {
    try {
      const buffer = (await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger, reuploadRequest: sock!.updateMediaMessage },
      )) as Buffer;
      return { from, waMessageId, type: "audio", text: "", timestamp, profileName, phoneNumberId: null, audioBuffer: buffer, audioMimeType: audio.mimetype || "audio/ogg" };
    } catch (e) {
      log.error("[whatsapp] falha ao baixar áudio", e);
      return { from, waMessageId, type: "audio", text: "", timestamp, profileName, phoneNumberId: null, audioMimeType: audio.mimetype || "audio/ogg" };
    }
  }

  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    "";
  if (text) {
    return { from, waMessageId, type: "text", text, timestamp, profileName, phoneNumberId: null };
  }

  // Tipo não suportado — registra para o pipeline responder com gentileza.
  const kind = Object.keys(m)[0] || "unknown";
  return { from, waMessageId, type: kind, text: "", timestamp, profileName, phoneNumberId: null };
}

function toJid(to: string): string {
  if (to.includes("@")) return to;
  const d = (to || "").replace(/\D/g, "");
  return `${d}@s.whatsapp.net`;
}

export async function sendTextWA(to: string, body: string): Promise<void> {
  if (!sock || connState !== "open") throw new Error("WhatsApp (QR) não conectado.");
  const r = await sock.sendMessage(toJid(to), { text: body });
  rememberSent(r?.key?.id);
}

export async function sendImageWA(to: string, imageUrl: string, caption?: string): Promise<void> {
  if (!sock || connState !== "open") throw new Error("WhatsApp (QR) não conectado.");
  const r = await sock.sendMessage(toJid(to), { image: { url: imageUrl }, caption: caption || undefined });
  rememberSent(r?.key?.id);
}
