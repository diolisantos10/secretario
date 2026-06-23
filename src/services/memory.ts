/** Memória de longo prazo — fatos que o secretário lembra entre conversas. */
import { prisma } from "../db";

export interface Fact {
  category: string;
  key: string;
  value: string;
  salience: number;
}

const MAX_FACTS_IN_CONTEXT = 40;

/** Salva ou atualiza um fato (upsert por categoria+chave). */
export async function saveFact(input: {
  category?: string;
  key: string;
  value: string;
  salience?: number;
}): Promise<void> {
  const category = (input.category || "geral").trim().toLowerCase();
  const key = input.key.trim();
  const salience = Math.min(5, Math.max(1, input.salience ?? 3));
  await prisma.memoryFact.upsert({
    where: { category_key: { category, key } },
    update: { value: input.value, salience },
    create: { category, key, value: input.value, salience },
  });
}

/** Esquece um fato pela chave (em qualquer categoria). Retorna quantos removeu. */
export async function forgetFact(key: string): Promise<number> {
  const res = await prisma.memoryFact.deleteMany({ where: { key: key.trim() } });
  return res.count;
}

/** Fatos mais salientes/recentes, para injetar no contexto. */
export async function loadFacts(): Promise<Fact[]> {
  const rows = await prisma.memoryFact.findMany({
    orderBy: [{ salience: "desc" }, { updatedAt: "desc" }],
    take: MAX_FACTS_IN_CONTEXT,
    select: { category: true, key: true, value: true, salience: true },
  });
  return rows;
}

/** Formata os fatos para o contexto (agrupados por categoria). */
export function formatFacts(facts: Fact[]): string {
  if (facts.length === 0) return "(ainda não há fatos memorizados)";
  const byCat = new Map<string, Fact[]>();
  for (const f of facts) {
    const arr = byCat.get(f.category) ?? [];
    arr.push(f);
    byCat.set(f.category, arr);
  }
  const lines: string[] = [];
  for (const [cat, items] of byCat) {
    lines.push(`• ${cat}:`);
    for (const it of items) lines.push(`   - ${it.key}: ${it.value}`);
  }
  return lines.join("\n");
}
