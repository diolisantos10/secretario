/**
 * O cérebro: laço agêntico sobre a Messages API do Claude.
 *
 * Modelo: claude-opus-4-8 · thinking adaptativo · effort configurável ·
 * prompt caching no system · busca na web (web_search_20260209) + ferramentas custom.
 * O contexto dinâmico (data, memória, lembretes, agenda) entra como mensagem de
 * sistema no meio da conversa (recurso do Opus 4.8) — com fallback para modelos
 * que não suportam.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { cred, anthropicReady } from "../services/credentials";
import { log } from "../logger";
import { SYSTEM_PROMPT, buildDynamicContext } from "./prompt";
import { toolDefs, executeTool } from "./tools";
import { prisma } from "../db";
import { loadHistory, type ChatTurn } from "../services/conversation";
import { loadFacts, formatFacts } from "../services/memory";
import { listReminders, formatReminders } from "../services/reminders";
import { listToday, isConnected as calendarConnected } from "../services/calendar";
import { formatListsForContext } from "../services/lists";
import { formatDashboardsForContext } from "../services/dashboards";

const MAX_ITERATIONS = 8;
const IMAGE_PREFIX = "IMAGE_GENERATED::";

export interface SecretaryResponse {
  text: string;
  imageUrl?: string;
  imageCaption?: string;
}

/** Anexo multimodal do turno atual (imagem para visão, PDF para leitura). */
export interface Attachment {
  kind: "image" | "document";
  base64: string;
  mimeType: string;
  name?: string;
}

let client: Anthropic | null = null;
let lastApiKey = "";
function getClient(): Anthropic {
  const key = cred("ANTHROPIC_API_KEY");
  if (!key) throw new Error("Claude não configurado — adicione a chave Anthropic pelo painel.");
  if (!client || lastApiKey !== key) {
    lastApiKey = key;
    client = new Anthropic({ apiKey: key });
  }
  return client;
}

/** Verifica se a chave Claude (Anthropic) está presente e é aceita. */
export async function testAnthropicKey(): Promise<{ ok: boolean; error?: string }> {
  const key = cred("ANTHROPIC_API_KEY");
  if (!key) return { ok: false, error: "Nenhuma chave Claude (Anthropic) salva no sistema." };
  try {
    const c = getClient();
    await c.models.list();
    return { ok: true };
  } catch (e: any) {
    const status = e?.status;
    if (status === 401)
      return {
        ok: false,
        error: "A chave foi salva, mas a Anthropic recusou (401). Confira se você não colou a chave da OpenAI (sk-proj…) no campo do Claude — a do Claude começa com sk-ant-.",
      };
    return { ok: false, error: e?.message || "Falha ao falar com a Anthropic." };
  }
}

function webSearchTool() {
  return config.ENABLE_WEB_SEARCH ? [{ type: "web_search_20260209", name: "web_search" }] : [];
}

function extractText(content: any[]): string {
  return content
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function logUsage(msg: any): Promise<void> {
  try {
    const u = msg?.usage ?? {};
    await prisma.aiLog.create({
      data: {
        model: msg?.model ?? config.ANTHROPIC_MODEL,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    });
  } catch (e) {
    log.debug("[secretary] logUsage falhou", e);
  }
}

/** Monta o array de mensagens. Garante início em 'user' e injeta o contexto. */
function buildMessages(
  history: ChatTurn[],
  contextText: string,
  systemAsMessage: boolean,
  attachments: Attachment[] = [],
): any[] {
  let hist = history.slice();
  while (hist.length && hist[0].role !== "user") hist = hist.slice(1);

  const messages: any[] = hist.map((t) => ({ role: t.role, content: t.content }));

  if (systemAsMessage) {
    messages.push({ role: "system", content: contextText });
  } else {
    // Fallback: anexa o contexto ao último turno do usuário.
    const last = messages[messages.length - 1];
    if (last && last.role === "user" && typeof last.content === "string") {
      last.content = `${last.content}\n\n<contexto>\n${contextText}\n</contexto>`;
    } else {
      messages.push({ role: "user", content: `<contexto>\n${contextText}\n</contexto>` });
    }
  }

  // Anexos do turno (imagem/PDF): injeta como blocks na última mensagem do usuário.
  if (attachments.length) {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { idx = i; break; }
    }
    if (idx === -1) { messages.push({ role: "user", content: "" }); idx = messages.length - 1; }
    const m = messages[idx];
    const textPart = typeof m.content === "string" ? m.content : "";
    const blocks: any[] = [];
    if (textPart.trim()) blocks.push({ type: "text", text: textPart });
    for (const a of attachments) {
      if (a.kind === "image") {
        blocks.push({ type: "image", source: { type: "base64", media_type: a.mimeType, data: a.base64 } });
      } else {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: a.mimeType, data: a.base64 },
          ...(a.name ? { title: a.name } : {}),
        });
      }
    }
    if (!blocks.some((b) => b.type === "text")) blocks.unshift({ type: "text", text: "Segue o anexo." });
    m.content = blocks;
  }
  return messages;
}

/** Executa uma promessa de contexto com fallback — nunca derruba a resposta. */
async function safeCtx<T>(p: Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    log.warn(`[secretary] contexto "${label}" indisponível`, e);
    return fallback;
  }
}

async function gatherContext(): Promise<string> {
  const [facts, reminders, lists, dashboards] = await Promise.all([
    safeCtx(loadFacts(), [], "memória"),
    safeCtx(listReminders(), [], "lembretes"),
    safeCtx(formatListsForContext(), "(indisponível agora)", "listas"),
    safeCtx(formatDashboardsForContext(), "(indisponível agora)", "painéis"),
  ]);
  let agenda = "(agenda do Google não conectada)";
  try {
    if (await calendarConnected()) {
      const events = await listToday();
      agenda = events.length
        ? events.map((e) => `• ${e.start} → ${e.summary}`).join("\n")
        : "(sem eventos hoje)";
    }
  } catch (e) {
    log.debug("[secretary] agenda indisponível", e);
  }
  return buildDynamicContext({
    memory: formatFacts(facts),
    reminders: formatReminders(reminders),
    agenda,
    lists,
    dashboards,
  });
}

function baseParams(messages: any[]) {
  return {
    model: config.ANTHROPIC_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: config.ANTHROPIC_EFFORT },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [...toolDefs, ...webSearchTool()],
    messages,
  };
}

/**
 * Processa a conversa atual (histórico já inclui a última mensagem do dono) e
 * devolve a resposta. Persistir/enviar é responsabilidade de quem chama.
 */
export async function respond(attachments: Attachment[] = []): Promise<SecretaryResponse> {
  const c = getClient();
  const history = await loadHistory();
  const contextText = await gatherContext();

  let systemAsMessage = config.ANTHROPIC_MODEL.includes("opus-4-8");
  let messages = buildMessages(history, contextText, systemAsMessage, attachments);

  let finalText = "";
  let pendingImageUrl: string | undefined;
  let pendingImageCaption: string | undefined;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let msg: any;
    try {
      const stream = c.messages.stream(baseParams(messages) as any);
      msg = await stream.finalMessage();
    } catch (e) {
      // Modelo não suporta mensagem de sistema no meio? Refaz com fallback, uma vez.
      if (systemAsMessage && e instanceof Anthropic.BadRequestError && /system/i.test(e.message)) {
        log.warn("[secretary] modelo sem system mid-conversation — usando fallback de contexto");
        systemAsMessage = false;
        messages = buildMessages(history, contextText, false, attachments);
        i--;
        continue;
      }
      throw e;
    }

    await logUsage(msg);
    messages.push({ role: "assistant", content: msg.content });

    if (msg.stop_reason === "pause_turn") continue; // ferramenta de servidor (web search) — retoma
    if (msg.stop_reason === "refusal") {
      finalText = "Desculpa, isso eu não consigo fazer.";
      break;
    }
    if (msg.stop_reason === "tool_use") {
      const results: any[] = [];
      for (const block of msg.content) {
        if (block?.type === "tool_use") {
          let out = await executeTool(block.name, block.input);
          if (out.startsWith(IMAGE_PREFIX)) {
            const parts = out.slice(IMAGE_PREFIX.length).split("::");
            pendingImageUrl = parts[0];
            pendingImageCaption = parts[1] ?? "";
            out = "Imagem gerada com sucesso. Avise o dono brevemente que a imagem foi criada e enviada.";
          }
          results.push({ type: "tool_result", tool_use_id: block.id, content: out });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    finalText = extractText(msg.content);
    break;
  }

  return {
    text: finalText || "Recebi sua mensagem, mas não consegui formular uma resposta agora.",
    imageUrl: pendingImageUrl,
    imageCaption: pendingImageCaption,
  };
}

/**
 * Gera um texto proativo (ex.: briefing matinal) a partir de uma instrução
 * interna, com o contexto atual. Não usa o histórico como base e não exige
 * ferramentas — é uma chamada única e curta.
 */
export async function composeProactive(instruction: string): Promise<string> {
  const c = getClient();
  const contextText = await gatherContext();
  const messages = [
    { role: "user", content: `${instruction}\n\n<contexto>\n${contextText}\n</contexto>` },
  ];
  const res: any = await c.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages,
  } as any);
  await logUsage(res);
  return extractText(res.content);
}
