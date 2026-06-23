/** Lembretes e tarefas com horário. */
import { prisma } from "../db";
import { fmtShort } from "../util/datetime";

export async function createReminder(text: string, dueAt: Date): Promise<{ id: string }> {
  const r = await prisma.reminder.create({
    data: { text, dueAt, status: "pending" },
    select: { id: true },
  });
  return r;
}

export async function listReminders(status?: string) {
  return prisma.reminder.findMany({
    where: status ? { status } : { status: { in: ["pending", "sent"] } },
    orderBy: { dueAt: "asc" },
    take: 50,
  });
}

export async function cancelReminder(id: string): Promise<boolean> {
  const res = await prisma.reminder.updateMany({
    where: { id, status: { in: ["pending", "sent"] } },
    data: { status: "cancelled" },
  });
  return res.count > 0;
}

export async function completeReminder(id: string): Promise<boolean> {
  const res = await prisma.reminder.updateMany({
    where: { id },
    data: { status: "done" },
  });
  return res.count > 0;
}

/** Lembretes vencidos ainda pendentes — usados pelo agendador para disparar. */
export async function dueReminders(now: Date = new Date()) {
  return prisma.reminder.findMany({
    where: { status: "pending", dueAt: { lte: now } },
    orderBy: { dueAt: "asc" },
  });
}

export async function markSent(id: string): Promise<void> {
  await prisma.reminder.update({ where: { id }, data: { status: "sent" } });
}

/** Lembretes em aberto formatados para contexto/briefing. */
export function formatReminders(rows: { id: string; text: string; dueAt: Date }[]): string {
  if (rows.length === 0) return "(nenhum lembrete em aberto)";
  return rows.map((r) => `• [${r.id.slice(-6)}] ${fmtShort(r.dueAt)} — ${r.text}`).join("\n");
}
