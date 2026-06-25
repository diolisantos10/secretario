/**
 * Painéis dinâmicos — a evolução das listas: o secretário monta interfaces de
 * planejamento sob demanda (KPIs, tabelas, cronogramas, gráficos, checklists)
 * a partir de pedidos em linguagem natural, e o painel web as renderiza
 * genericamente. Sem código novo a cada nova demanda.
 *
 * Um painel é um título + uma lista de "blocos". Cada bloco tem um `type` e os
 * campos correspondentes. Tipos suportados (renderizados pelo painel):
 *   - heading   { text }
 *   - text      { text }                          (parágrafo)
 *   - kpis      { items: [{ label, value, hint? }] }
 *   - table     { columns: [..], rows: [[..],..] }
 *   - checklist { items: [{ text, done? }] }
 *   - bars      { title?, items: [{ label, value }] }   (gráfico de barras)
 *   - timeline  { items: [{ when, text }] }
 */
import { prisma } from "../db";

export type Block = Record<string, any> & { type: string };

export interface DashboardData {
  id: string;
  title: string;
  emoji: string | null;
  blocks: Block[];
  updatedAt: Date;
}

const KNOWN_TYPES = new Set(["heading", "text", "kpis", "table", "checklist", "bars", "timeline"]);

/** Mantém só blocos com type conhecido e formato mínimo válido. */
function sanitizeBlocks(input: unknown): Block[] {
  if (!Array.isArray(input)) return [];
  const out: Block[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Block;
    if (!KNOWN_TYPES.has(b.type)) continue;
    out.push(b);
  }
  return out;
}

function parseBlocks(json: string): Block[] {
  try {
    return sanitizeBlocks(JSON.parse(json));
  } catch {
    return [];
  }
}

/** Acha um painel pelo título (case-insensitive) ou pelos últimos 6 chars do id. */
export async function findDashboard(ref: string): Promise<{ id: string; title: string } | null> {
  const clean = (ref || "").trim();
  if (!clean) return null;
  const byTitle = await prisma.dashboard.findFirst({
    where: { archived: false, title: { equals: clean, mode: "insensitive" } },
    select: { id: true, title: true },
  });
  if (byTitle) return byTitle;
  const partial = await prisma.dashboard.findFirst({
    where: { archived: false, title: { contains: clean, mode: "insensitive" } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true },
  });
  if (partial) return partial;
  const all = await prisma.dashboard.findMany({ where: { archived: false }, select: { id: true, title: true } });
  return all.find((d) => d.id.endsWith(clean)) ?? null;
}

/** Cria ou atualiza um painel pelo título. mode "append" concatena blocos. */
export async function upsertDashboard(input: {
  title: string;
  emoji?: string;
  blocks: unknown;
  mode?: "replace" | "append";
}): Promise<DashboardData> {
  const blocks = sanitizeBlocks(input.blocks);
  const existing = await findDashboard(input.title);
  if (existing) {
    const current = input.mode === "append" ? (await getDashboard(existing.id))?.blocks ?? [] : [];
    const merged = input.mode === "append" ? [...current, ...blocks] : blocks;
    await prisma.dashboard.update({
      where: { id: existing.id },
      data: { emoji: input.emoji || undefined, blocks: JSON.stringify(merged), archived: false },
    });
    return (await getDashboard(existing.id))!;
  }
  const created = await prisma.dashboard.create({
    data: { title: input.title.trim(), emoji: input.emoji || null, blocks: JSON.stringify(blocks) },
  });
  return (await getDashboard(created.id))!;
}

export async function getDashboard(id: string): Promise<DashboardData | null> {
  const d = await prisma.dashboard.findUnique({ where: { id } });
  if (!d) return null;
  return { id: d.id, title: d.title, emoji: d.emoji, blocks: parseBlocks(d.blocks), updatedAt: d.updatedAt };
}

export async function allDashboards(): Promise<DashboardData[]> {
  const rows = await prisma.dashboard.findMany({ where: { archived: false }, orderBy: { updatedAt: "desc" } });
  return rows.map((d) => ({ id: d.id, title: d.title, emoji: d.emoji, blocks: parseBlocks(d.blocks), updatedAt: d.updatedAt }));
}

export async function archiveDashboard(id: string): Promise<void> {
  await prisma.dashboard.update({ where: { id }, data: { archived: true } });
}

/** Resumo curto dos painéis para o contexto do secretário. */
export async function formatDashboardsForContext(): Promise<string> {
  const ds = await allDashboards();
  if (!ds.length) return "(nenhum painel criado ainda)";
  return ds
    .map((d) => `${d.emoji ? d.emoji + " " : ""}${d.title} (id ${d.id.slice(-6)}, ${d.blocks.length} bloco(s))`)
    .join("\n");
}
