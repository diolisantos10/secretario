/** Histórico da conversa — memória de curto prazo (texto puro). */
import { prisma } from "../db";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const HISTORY_LIMIT = 24; // últimas N mensagens enviadas ao modelo

/** Já processamos esta mensagem (dedupe por wamid)? */
export async function alreadyProcessed(waMessageId: string): Promise<boolean> {
  if (!waMessageId) return false;
  const found = await prisma.message.findUnique({
    where: { waMessageId },
    select: { id: true },
  });
  return Boolean(found);
}

export async function saveUserMessage(content: string, waMessageId?: string): Promise<void> {
  await prisma.message.create({
    data: { role: "user", content, waMessageId: waMessageId || null },
  });
}

export async function saveAssistantMessage(content: string): Promise<void> {
  if (!content.trim()) return;
  await prisma.message.create({ data: { role: "assistant", content } });
}

/** Apaga o histórico de bate-papo (não mexe em memória, lembretes ou listas). */
export async function clearHistory(): Promise<number> {
  const r = await prisma.message.deleteMany({});
  return r.count;
}

/** Últimos turnos em ordem cronológica, prontos para o array `messages` do Claude. */
export async function loadHistory(): Promise<ChatTurn[]> {
  const rows = await prisma.message.findMany({
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  });
  return rows
    .reverse()
    .map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: r.content }) as ChatTurn);
}
