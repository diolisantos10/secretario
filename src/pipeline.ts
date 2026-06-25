/**
 * Orquestração de uma mensagem recebida até a resposta enviada.
 *
 * - Dedupe por wamid e allow-list (só o dono).
 * - Debounce: agrupa rajadas de mensagens em um único processamento.
 * - Single-flight: se chegarem mensagens durante o processamento, re-processa
 *   uma vez ao final, em vez de responder em paralelo.
 */
import { log } from "./logger";
import { prisma } from "./db";
import { isOwner, ownerNumber } from "./util/phone";
import { cred, setCredentials } from "./services/credentials";
import type { IncomingMessage } from "./whatsapp/meta";
import { sendText, sendImage, markRead, downloadMedia } from "./whatsapp/channel";
import { sendTextTG, sendImageTG, telegramConnected } from "./whatsapp/telegram";
import { alreadyProcessed, saveUserMessage, saveAssistantMessage } from "./services/conversation";
import { respond, type SecretaryResponse, type Attachment } from "./brain/secretary";
import { transcribeAudio } from "./services/transcription";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // limite prático da API de visão
const MAX_PDF_BYTES = 20 * 1024 * 1024; // limite de download do Telegram

/** Anexos (imagem/PDF) do turno atual, repassados ao cérebro. */
let pendingAttachments: Attachment[] = [];

const DEBOUNCE_MS = 1200;

let debounceTimer: NodeJS.Timeout | null = null;
let running = false;
let rerun = false;

/** Para onde a próxima resposta vai — definido pela última mensagem do dono. */
type ReplyTarget = { channel: "telegram"; chatId: string } | { channel: "whatsapp" };
let replyTarget: ReplyTarget = { channel: "whatsapp" };

/** Entrega texto/imagem no canal da última mensagem recebida. */
async function deliver(text: string, imageUrl?: string | null, caption?: string | null): Promise<void> {
  if (replyTarget.channel === "telegram") {
    if (imageUrl) await sendImageTG(replyTarget.chatId, imageUrl, caption || undefined);
    if (text) await sendTextTG(replyTarget.chatId, text);
  } else {
    if (imageUrl) await sendImage(ownerNumber(), imageUrl, caption || undefined);
    if (text) await sendText(ownerNumber(), text);
  }
}

/** Telegram: o primeiro chat que falar com o bot é adotado como dono. */
function telegramOwnerOk(chatId: string | undefined): boolean {
  if (!chatId) return false;
  const owner = cred("TELEGRAM_OWNER_CHAT_ID");
  if (!owner) {
    void setCredentials({ TELEGRAM_OWNER_CHAT_ID: chatId });
    log.info(`[telegram] dono definido automaticamente: chat ${chatId}`);
    return true;
  }
  return owner === chatId;
}

/** Há uma mensagem do dono ainda sem resposta? */
async function hasPendingUser(): Promise<boolean> {
  const last = await prisma.message.findFirst({
    orderBy: { createdAt: "desc" },
    select: { role: true },
  });
  return last?.role === "user";
}

function scheduleProcessing(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void process_();
  }, DEBOUNCE_MS);
}

async function process_(): Promise<void> {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      if (!(await hasPendingUser())) break;
      const atts = pendingAttachments;
      pendingAttachments = [];
      const response = await respond(atts);
      await saveAssistantMessage(response.text);
      await deliver(response.text, response.imageUrl, response.imageCaption);
    } while (rerun);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    log.error("[pipeline] falha ao responder", e);
    try {
      await deliver(`Tive um problema aqui para responder agora (${errMsg}). Pode repetir daqui a pouco?`);
    } catch {
      /* sem rede para avisar — já logamos acima */
    }
  } finally {
    running = false;
  }
}

/** Ponto de entrada do webhook: recebe mensagens já parseadas. */
export async function handleIncoming(messages: IncomingMessage[]): Promise<void> {
  let sawOwnerText = false;

  for (const m of messages) {
    const isTelegram = m.channel === "telegram";

    // Allow-list por canal: WhatsApp pelo número; Telegram pelo chat id (auto-adoção).
    if (isTelegram) {
      if (!telegramOwnerOk(m.chatId)) {
        log.warn(`[pipeline] Telegram ignorado (não é o dono): chat ${m.chatId}`);
        continue;
      }
      replyTarget = { channel: "telegram", chatId: m.chatId! };
    } else {
      if (!isOwner(m.from)) {
        log.warn(`[pipeline] mensagem ignorada (não é o dono): ${m.from}`);
        continue;
      }
      replyTarget = { channel: "whatsapp" };
    }

    if (await alreadyProcessed(m.waMessageId)) continue;

    if (!isTelegram) void markRead(m.waMessageId);

    // Áudio: transcreve com Whisper e trata como texto
    if (m.type === "audio") {
      try {
        let buffer = m.audioBuffer ?? null;
        let mime = m.audioMimeType ?? "audio/ogg";
        if (!buffer && m.audioMediaId) {
          const dl = await downloadMedia(m.audioMediaId);
          buffer = dl.buffer;
          mime = m.audioMimeType ?? dl.mimeType;
        }
        if (!buffer) throw new Error("áudio sem conteúdo para transcrever");
        const transcription = await transcribeAudio(buffer, mime);
        log.info(`[pipeline] áudio transcrito (${transcription.length} chars)`);
        if (!transcription.trim()) {
          await saveUserMessage("[áudio vazio — Whisper não retornou texto]", m.waMessageId);
          await deliver("Recebi o áudio mas o Whisper não devolveu nenhum texto. Tenta falar um pouco mais alto/perto?").catch(() => {});
          continue;
        }
        await saveUserMessage(`🎤 ${transcription}`, m.waMessageId);
        sawOwnerText = true;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "erro desconhecido";
        log.error("[pipeline] falha na transcrição de áudio", e);
        await saveUserMessage(`[áudio — erro na transcrição: ${errMsg}]`, m.waMessageId);
        await deliver(`Ouvi seu áudio mas não consegui transcrever: ${errMsg}`).catch(() => {});
      }
      continue;
    }

    // Imagem: o Claude enxerga nativamente — anexa ao turno.
    if (m.type === "image") {
      const buf = m.imageBuffer ?? null;
      if (!buf) {
        await saveUserMessage("[imagem sem conteúdo]", m.waMessageId);
        await deliver("Recebi uma imagem mas ela veio vazia. Pode reenviar?").catch(() => {});
        continue;
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        await saveUserMessage("[imagem grande demais]", m.waMessageId);
        await deliver("Essa imagem passou de 5 MB. Manda uma versão um pouco menor que eu analiso.").catch(() => {});
        continue;
      }
      const caption = (m.text || "").trim();
      pendingAttachments.push({ kind: "image", base64: buf.toString("base64"), mimeType: m.imageMimeType || "image/jpeg" });
      await saveUserMessage(caption ? `🖼️ ${caption}` : "🖼️ [imagem]", m.waMessageId);
      sawOwnerText = true;
      continue;
    }

    // Documento: PDF e texto vão direto ao Claude; outros formatos, aviso claro.
    if (m.type === "document") {
      const buf = m.docBuffer ?? null;
      const mime = (m.docMimeType || "application/octet-stream").toLowerCase();
      const name = m.docName || "documento";
      if (!buf) {
        await saveUserMessage("[documento sem conteúdo]", m.waMessageId);
        await deliver("Recebi um arquivo mas ele veio vazio. Pode reenviar?").catch(() => {});
        continue;
      }
      const caption = (m.text || "").trim();
      if (mime === "application/pdf") {
        if (buf.length > MAX_PDF_BYTES) {
          await saveUserMessage(`[PDF grande demais: ${name}]`, m.waMessageId);
          await deliver("Esse PDF passou de 20 MB e o Telegram não deixa baixar. Dá pra mandar uma versão menor ou só as páginas que importam?").catch(() => {});
          continue;
        }
        pendingAttachments.push({ kind: "document", base64: buf.toString("base64"), mimeType: "application/pdf", name });
        await saveUserMessage(`📄 ${name}${caption ? ` — ${caption}` : ""}`, m.waMessageId);
        sawOwnerText = true;
      } else if (mime.startsWith("text/") || mime === "application/json") {
        const txt = buf.toString("utf8").slice(0, 12000);
        await saveUserMessage(`📄 ${name}${caption ? ` — ${caption}` : ""}:\n${txt}`, m.waMessageId);
        sawOwnerText = true;
      } else {
        await saveUserMessage(`[documento ${mime} não suportado: ${name}]`, m.waMessageId);
        await deliver(`Recebi "${name}", mas por enquanto leio PDF, imagens e arquivos de texto — esse é ${mime}. Se der, exporta como PDF que eu leio.`).catch(() => {});
      }
      continue;
    }

    if (m.type !== "text" || !m.text.trim()) {
      const diag = m.text?.trim() ? ` Diagnóstico — ${m.text.trim()}` : "";
      await saveUserMessage(`[mensagem ${m.type} não suportada]`, m.waMessageId);
      await deliver(`Isso não chegou num formato que eu consiga processar.${diag}`).catch(() => {});
      continue;
    }

    await saveUserMessage(m.text.trim(), m.waMessageId);
    sawOwnerText = true;
  }

  if (sawOwnerText) scheduleProcessing();
}

/**
 * Processa um turno direto (ex.: chat do painel web) e devolve a resposta.
 * Usa o mesmo cérebro, histórico e memória do WhatsApp — é o MESMO secretário —
 * mas não envia nada pelo WhatsApp. Ideal para testar/planejar pelo navegador.
 */
export async function runDirectTurn(text: string): Promise<SecretaryResponse> {
  const clean = text.trim();
  if (!clean) return { text: "" };
  await saveUserMessage(clean);
  const response = await respond();
  await saveAssistantMessage(response.text);
  return response;
}

/** Envio proativo (lembretes/briefing): manda pelo canal conectado e guarda o turno. */
export async function sendProactive(text: string): Promise<void> {
  if (!text.trim()) return;
  const tgChat = cred("TELEGRAM_OWNER_CHAT_ID");
  if (telegramConnected() && tgChat) {
    await sendTextTG(tgChat, text);
  } else {
    await sendText(ownerNumber(), text);
  }
  await saveAssistantMessage(text);
}
