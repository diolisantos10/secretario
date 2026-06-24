/**
 * Listas/coleções sob demanda — a primitiva genérica do secretário.
 *
 * Uma única estrutura (lista + itens checáveis) cobre infinitas demandas:
 * compras, tarefas de um projeto, ideias, livros, etapas de um plano, etc.
 * Quando o dono pede "faz uma lista/quadro/checklist de X", o secretário cria
 * uma List; o painel renderiza todas como cards (um dashboard vivo), sem
 * precisar de código novo a cada pedido.
 */
import { prisma } from "../db";

/** Atualiza o updatedAt da lista (faz ela subir no painel). */
async function touch(listId: string): Promise<void> {
  await prisma.list.update({ where: { id: listId }, data: { updatedAt: new Date() } });
}

export interface ListWithItems {
  id: string;
  name: string;
  kind: string;
  emoji: string | null;
  items: { id: string; text: string; done: boolean; note: string | null }[];
}

/** Acha uma lista pelo nome (case-insensitive) ou pelos últimos 6 chars do id. */
export async function findList(ref: string): Promise<{ id: string; name: string } | null> {
  const clean = ref.trim();
  if (!clean) return null;
  const byName = await prisma.list.findFirst({
    where: { archived: false, name: { equals: clean, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (byName) return byName;
  const partial = await prisma.list.findFirst({
    where: { archived: false, name: { contains: clean, mode: "insensitive" } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true },
  });
  if (partial) return partial;
  const all = await prisma.list.findMany({ where: { archived: false }, select: { id: true, name: true } });
  return all.find((l) => l.id.endsWith(clean)) ?? null;
}

/** Cria (ou reaproveita) uma lista e adiciona itens iniciais. */
export async function createList(input: {
  name: string;
  kind?: string;
  emoji?: string;
  items?: string[];
}): Promise<ListWithItems> {
  const existing = await findList(input.name);
  const list = existing
    ? await prisma.list.update({
        where: { id: existing.id },
        data: { kind: input.kind || undefined, emoji: input.emoji || undefined },
      })
    : await prisma.list.create({
        data: { name: input.name.trim(), kind: input.kind || "checklist", emoji: input.emoji || null },
      });
  if (input.items?.length) await addItems(list.id, input.items);
  return (await getList(list.id))!;
}

/** Adiciona itens a uma lista existente (pelo id). */
export async function addItems(listId: string, texts: string[]): Promise<number> {
  const start = await prisma.listItem.count({ where: { listId } });
  const data = texts
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text, i) => ({ listId, text, position: start + i }));
  if (!data.length) return 0;
  await prisma.listItem.createMany({ data });
  await touch(listId);
  return data.length;
}

/** Marca itens como feitos/não feitos por correspondência de texto. Retorna quantos mudaram. */
export async function setDone(listId: string, itemTexts: string[], done: boolean): Promise<number> {
  const items = await prisma.listItem.findMany({ where: { listId } });
  let changed = 0;
  for (const needle of itemTexts) {
    const n = needle.trim().toLowerCase();
    const match =
      items.find((it) => it.text.toLowerCase() === n) ?? items.find((it) => it.text.toLowerCase().includes(n));
    if (match && match.done !== done) {
      await prisma.listItem.update({ where: { id: match.id }, data: { done } });
      match.done = done;
      changed++;
    }
  }
  if (changed) await touch(listId);
  return changed;
}

/** Remove itens por texto. Retorna quantos saíram. */
export async function removeItems(listId: string, itemTexts: string[]): Promise<number> {
  const items = await prisma.listItem.findMany({ where: { listId } });
  const ids: string[] = [];
  for (const needle of itemTexts) {
    const n = needle.trim().toLowerCase();
    const match =
      items.find((it) => it.text.toLowerCase() === n) ?? items.find((it) => it.text.toLowerCase().includes(n));
    if (match && !ids.includes(match.id)) ids.push(match.id);
  }
  if (!ids.length) return 0;
  await prisma.listItem.deleteMany({ where: { id: { in: ids } } });
  await touch(listId);
  return ids.length;
}

/** Arquiva uma lista (some do painel, mas não é apagada de fato). */
export async function archiveList(listId: string): Promise<void> {
  await prisma.list.update({ where: { id: listId }, data: { archived: true } });
}

export async function getList(id: string): Promise<ListWithItems | null> {
  const l = await prisma.list.findUnique({
    where: { id },
    include: { items: { orderBy: [{ done: "asc" }, { position: "asc" }] } },
  });
  if (!l) return null;
  return {
    id: l.id,
    name: l.name,
    kind: l.kind,
    emoji: l.emoji,
    items: l.items.map((it) => ({ id: it.id, text: it.text, done: it.done, note: it.note })),
  };
}

/** Todas as listas ativas, com itens (para o painel e para o contexto do modelo). */
export async function allLists(): Promise<ListWithItems[]> {
  const rows = await prisma.list.findMany({
    where: { archived: false },
    orderBy: { updatedAt: "desc" },
    include: { items: { orderBy: [{ done: "asc" }, { position: "asc" }] } },
  });
  return rows.map((l) => ({
    id: l.id,
    name: l.name,
    kind: l.kind,
    emoji: l.emoji,
    items: l.items.map((it) => ({ id: it.id, text: it.text, done: it.done, note: it.note })),
  }));
}

/** Resumo curto de todas as listas para injetar no contexto do secretário. */
export async function formatListsForContext(): Promise<string> {
  const lists = await allLists();
  if (!lists.length) return "(nenhuma lista criada ainda)";
  return lists
    .map((l) => {
      const open = l.items.filter((i) => !i.done).length;
      const head = `${l.emoji ? l.emoji + " " : ""}${l.name} (id ${l.id.slice(-6)}, ${open}/${l.items.length} em aberto)`;
      const preview = l.items
        .slice(0, 6)
        .map((i) => `   ${i.done ? "✓" : "•"} ${i.text}`)
        .join("\n");
      return l.items.length ? `${head}\n${preview}` : head;
    })
    .join("\n");
}
