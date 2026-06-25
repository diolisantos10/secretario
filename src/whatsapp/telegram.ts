/**
 * Telegram — bot pela API oficial (criado no @BotFather).
 *
 * É o caminho mais simples para falar com o secretário como um CONTATO separado,
 * sem precisar de segundo número de telefone: o dono cria um bot no @BotFather,
 * cola o token no painel e conversa com o bot normalmente.
 *
 * Usa long polling (getUpdates) — não precisa de webhook nem de URL pública
 * configurada. O primeiro chat que falar com o bot é adotado como dono.
 */
import { log } from "../logger";
import { cred, setCredentials } from "../services/credentials";
import type { IncomingMessage } from "./meta";
import crypto from "node:crypto";

const API = "https://api.telegram.org";
const TG_TEXT_LIMIT = 4000; // limite do Telegram é 4096; deixamos folga

/** Identidade deste processo — se mudar entre requisições, há mais de uma réplica. */
const BOOT_ID = crypto.randomBytes(3).toString("hex");
const BOOT_AT = Date.now();
let updatesSeen = 0; // total de updates processados desde o boot

export type TgState = "idle" | "connecting" | "open" | "error";

let state: TgState = "idle";
let botUsername: string | null = null;
let polling = false;
let stopFlag = false;
let offset = 0;
let lastError: string | null = null;
let onMessage: ((msgs: IncomingMessage[]) => void) | null = null;

/** Buffer circular dos últimos updates (diagnóstico — visível no painel). */
type DebugEntry = { at: string; kind: string; fields: string[]; detail: string };
const recentUpdates: DebugEntry[] = [];
function pushDebug(e: DebugEntry): void {
  updatesSeen++;
  recentUpdates.unshift(e);
  if (recentUpdates.length > 15) recentUpdates.pop();
}
export function telegramDebug(): { bootId: string; uptimeSec: number; updatesSeen: number; offset: number; updates: DebugEntry[] } {
  return { bootId: BOOT_ID, uptimeSec: Math.round((Date.now() - BOOT_AT) / 1000), updatesSeen, offset, updates: recentUpdates };
}

function token(): string {
  return cred("TELEGRAM_BOT_TOKEN");
}

/** Quem recebe as mensagens normalizadas (definido pelo index, evita ciclo de import). */
export function setTelegramHandler(fn: (msgs: IncomingMessage[]) => void): void {
  onMessage = fn;
}

export function telegramReady(): boolean {
  return Boolean(token());
}
export function telegramConnected(): boolean {
  return state === "open";
}
export function telegramStatus(): { state: TgState; botUsername: string | null; ownerLinked: boolean; error: string | null; bootId: string; uptimeSec: number; updatesSeen: number } {
  return {
    state,
    botUsername,
    ownerLinked: Boolean(cred("TELEGRAM_OWNER_CHAT_ID")),
    error: lastError,
    bootId: BOOT_ID,
    uptimeSec: Math.round((Date.now() - BOOT_AT) / 1000),
    updatesSeen,
  };
}

// ---------------------------------------------------------------------------
// Chamadas à API
// ---------------------------------------------------------------------------

async function tg(method: string, body?: unknown, timeoutMs = 20000): Promise<any> {
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await res.json().catch(() => ({}))) as any;
  if (!j.ok) {
    const err: any = new Error(j.description || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return j.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadFile(fileId: string): Promise<Buffer> {
  const f = await tg("getFile", { file_id: fileId });
  const res = await fetch(`${API}/file/bot${token()}/${f.file_path}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Ciclo de vida (long polling)
// ---------------------------------------------------------------------------

/** Sobe o bot (idempotente). Faz getMe, garante modo polling e drena o backlog. */
export async function startTelegram(): Promise<void> {
  if (!token()) {
    state = "idle";
    return;
  }
  if (polling) return;
  stopFlag = false;
  polling = true;
  state = "connecting";
  lastError = null;
  try {
    const me = await tg("getMe");
    botUsername = me?.username ?? null;
    // Garante polling (remove webhook se algum dia tiver sido configurado).
    await tg("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    // Drena o backlog para não responder mensagens antigas após um reinício.
    try {
      const drained = await tg("getUpdates", { offset: -1, timeout: 0 });
      if (Array.isArray(drained) && drained.length) offset = drained[drained.length - 1].update_id + 1;
    } catch {
      /* ignore */
    }
    state = "open";
    log.info(`[telegram] conectado como @${botUsername ?? "?"}`);
    void pollLoop();
  } catch (e: any) {
    polling = false;
    state = "error";
    lastError = e?.status === 401 ? "Token inválido — confira o que o BotFather mandou." : e?.message || "falha ao conectar";
    log.error("[telegram] falha ao iniciar", lastError);
  }
}

async function pollLoop(): Promise<void> {
  while (!stopFlag) {
    let result: any[] = [];
    try {
      // long poll de 30s; o timeout HTTP precisa ser maior que isso.
      result = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] }, 45000);
      state = "open";
    } catch (e: any) {
      if (stopFlag) break;
      if (e?.status === 401) {
        state = "error";
        lastError = "Token inválido.";
        break;
      }
      if (e?.status === 409) {
        // Conflito: outro getUpdates/webhook ativo. Tenta limpar e segue.
        await tg("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
        await sleep(1500);
        continue;
      }
      // Rede/timeout: espera um pouco e tenta de novo.
      await sleep(3000);
      continue;
    }
    for (const u of result) {
      offset = Math.max(offset, (u.update_id ?? 0) + 1);
      try {
        const im = await toIncoming(u);
        if (im && onMessage) onMessage([im]);
      } catch (e) {
        log.error("[telegram] falha ao processar update", e);
      }
    }
  }
  polling = false;
}

/** Para o polling (mantém o token salvo). */
export function stopTelegram(): void {
  stopFlag = true;
  polling = false;
  state = "idle";
  botUsername = null;
}

/** Remove o bot: para o polling e apaga token e dono. */
export async function logoutTelegram(): Promise<void> {
  stopTelegram();
  await setCredentials({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_OWNER_CHAT_ID: "" });
  lastError = null;
}

/** No boot: se já há token salvo, inicia sozinho. */
export async function maybeAutoStartTelegram(): Promise<void> {
  if (token()) {
    log.info("[telegram] token encontrado — iniciando...");
    void startTelegram();
  }
}

// ---------------------------------------------------------------------------
// Normalização de entrada + envio
// ---------------------------------------------------------------------------

async function toIncoming(u: any): Promise<IncomingMessage | null> {
  const msg = u?.message;
  if (!msg || !msg.chat) {
    pushDebug({ at: new Date().toISOString(), kind: "sem-message", fields: Object.keys(u || {}), detail: "" });
    return null;
  }
  const chatId = String(msg.chat.id);
  const msgFields = Object.keys(msg).filter((k) => !["message_id", "from", "chat", "date"].includes(k));
  // Só conversa privada 1:1 (ignora grupos/canais).
  if (msg.chat.type && msg.chat.type !== "private") return null;

  const from = String(msg.from?.id ?? chatId);
  const profileName = msg.from?.first_name || msg.from?.username || null;
  const waMessageId = `tg:${chatId}:${msg.message_id}`;
  const timestamp = msg.date ? new Date(msg.date * 1000) : new Date();
  const base = {
    from,
    chatId,
    channel: "telegram" as const,
    waMessageId,
    timestamp,
    profileName,
    phoneNumberId: null,
  };

  // Voz / áudio (gravação, arquivo de música, nota de vídeo, ou doc com mime de áudio).
  const docIsAudio = msg.document && /^audio\//i.test(msg.document.mime_type || "");
  const voice = msg.voice || msg.audio || msg.video_note || (docIsAudio ? msg.document : null);
  if (voice?.file_id) {
    pushDebug({ at: new Date().toISOString(), kind: "áudio", fields: msgFields, detail: voice.mime_type || "audio/ogg" });
    try {
      const buffer = await downloadFile(voice.file_id);
      const mime = (voice.mime_type || "audio/ogg").split(";")[0];
      log.info(`[telegram] áudio recebido (${buffer.length} bytes, ${mime})`);
      return { ...base, type: "audio", text: "", audioBuffer: buffer, audioMimeType: mime };
    } catch (e) {
      log.error("[telegram] falha ao baixar áudio", e);
      const errMsg = e instanceof Error ? e.message : "erro";
      // Retorna como texto de erro para que o pipeline possa avisar o dono.
      return { ...base, type: "text", text: `[voz — não consegui baixar: ${errMsg}]` };
    }
  }

  let text = msg.text || msg.caption || "";
  if (text.trim() === "/start") text = "Olá!"; // primeira mensagem padrão do Telegram
  if (text) {
    pushDebug({ at: new Date().toISOString(), kind: "texto", fields: msgFields, detail: `${text.length} chars` });
    return { ...base, type: "text", text };
  }

  pushDebug({ at: new Date().toISOString(), kind: "unknown", fields: msgFields, detail: JSON.stringify(msg).slice(0, 200) });
  log.warn(`[telegram] update não reconhecido — campos: ${msgFields.join(", ")}`);
  // Embute os campos recebidos no texto para diagnóstico visível ao dono.
  return { ...base, type: "unknown", text: msgFields.length ? `campos: ${msgFields.join(", ")}` : "" };
}

function chunk(text: string, size = TG_TEXT_LIMIT): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function sendTextTG(chatId: string, body: string): Promise<void> {
  for (const part of chunk(body)) {
    await tg("sendMessage", { chat_id: chatId, text: part });
  }
}

export async function sendImageTG(chatId: string, imageUrl: string, caption?: string): Promise<void> {
  await tg("sendPhoto", { chat_id: chatId, photo: imageUrl, caption: caption || undefined });
}
