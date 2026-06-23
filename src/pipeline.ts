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
import { type IncomingMessage, sendText, markRead } from "./whatsapp/meta";
import { alreadyProcessed, saveUserMessage, saveAssistantMessage } from "./services/conversation";
import { respond } from "./brain/secretary";

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
      const reply = await respond();
      await saveAssistantMessage(reply);
      await sendText(ownerNumber(), reply);
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

    if (m.type !== "text" || !m.text.trim()) {
      // v1 trata só texto; registra para dedupe e avisa.
      await saveUserMessage(`[mensagem ${m.type} não suportada]`, m.waMessageId);
      await sendText(ownerNumber(), "Por enquanto eu só consigo ler mensagens de texto. 🙂").catch(() => {});
      continue;
    }

    await saveUserMessage(m.text.trim(), m.waMessageId);
    sawOwnerText = true;
  }

  if (sawOwnerText) scheduleProcessing();
}

/** Envio proativo (lembretes/briefing): envia ao dono e guarda como turno do assistente. */
export async function sendProactive(text: string): Promise<void> {
  if (!text.trim()) return;
  await sendText(ownerNumber(), text);
  await saveAssistantMessage(text);
}
