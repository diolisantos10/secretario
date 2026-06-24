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
import { type IncomingMessage, sendText, sendImage, markRead, downloadMedia } from "./whatsapp/meta";
import { alreadyProcessed, saveUserMessage, saveAssistantMessage } from "./services/conversation";
import { respond, type SecretaryResponse } from "./brain/secretary";
import { transcribeAudio } from "./services/transcription";

const DEBOUNCE_MS = 1200;

let debounceTimer: NodeJS.Timeout | null = null;
let running = false;
let rerun = false;

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
      const response = await respond();
      await saveAssistantMessage(response.text);
      if (response.imageUrl) {
        await sendImage(ownerNumber(), response.imageUrl, response.imageCaption || undefined);
      }
      await sendText(ownerNumber(), response.text);
    } while (rerun);
  } catch (e) {
    log.error("[pipeline] falha ao responder", e);
    try {
      await sendText(ownerNumber(), "Tive um problema aqui para responder agora. Pode repetir daqui a pouco?");
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
    if (!isOwner(m.from)) {
      log.warn(`[pipeline] mensagem ignorada (não é o dono): ${m.from}`);
      continue;
    }
    if (await alreadyProcessed(m.waMessageId)) continue;

    void markRead(m.waMessageId);

    // Áudio: transcreve com Whisper e trata como texto
    if (m.type === "audio" && m.audioMediaId) {
      try {
        const { buffer, mimeType } = await downloadMedia(m.audioMediaId);
        const transcription = await transcribeAudio(buffer, m.audioMimeType ?? mimeType);
        log.info(`[pipeline] áudio transcrito (${transcription.length} chars)`);
        await saveUserMessage(transcription, m.waMessageId);
        sawOwnerText = true;
      } catch (e) {
        log.error("[pipeline] falha na transcrição de áudio", e);
        await saveUserMessage(`[áudio — erro na transcrição]`, m.waMessageId);
        await sendText(ownerNumber(), "Ouvi seu áudio mas não consegui transcrever agora. Pode repetir escrevendo?").catch(() => {});
      }
      continue;
    }

    if (m.type !== "text" || !m.text.trim()) {
      await saveUserMessage(`[mensagem ${m.type} não suportada]`, m.waMessageId);
      await sendText(ownerNumber(), "Só consigo processar texto e áudio por enquanto. 🙂").catch(() => {});
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

/** Envio proativo (lembretes/briefing): envia ao dono e guarda como turno do assistente. */
export async function sendProactive(text: string): Promise<void> {
  if (!text.trim()) return;
  await sendText(ownerNumber(), text);
  await saveAssistantMessage(text);
}
