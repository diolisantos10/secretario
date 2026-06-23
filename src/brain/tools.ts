/** Ferramentas do secretário: definições (schema) + execução. */
import { config } from "../config";
import { log } from "../logger";
import { fmtLong } from "../util/datetime";
import { saveFact, forgetFact } from "../services/memory";
import {
  createReminder,
  listReminders,
  cancelReminder,
  completeReminder,
  formatReminders,
} from "../services/reminders";
import { listEvents, createEvent } from "../services/calendar";

/** Definições das ferramentas custom (o web_search é adicionado no secretary.ts). */
export const toolDefs = [
  {
    name: "save_memory",
    description:
      "Memoriza um fato durável sobre o dono para lembrar em conversas futuras (pessoas, preferências, projetos, rotinas, contatos, decisões). Atualiza se a mesma chave já existir.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Categoria curta: pessoa, preferencia, projeto, rotina, contato, geral...",
        },
        key: { type: "string", description: "Identificador curto e estável do fato (ex.: 'esposa', 'cafe')." },
        value: { type: "string", description: "O conteúdo do fato." },
        salience: { type: "integer", description: "Importância de 1 (baixa) a 5 (alta). Padrão 3." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "forget_memory",
    description: "Esquece um fato memorizado, pela sua chave.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string", description: "A chave do fato a remover." } },
      required: ["key"],
    },
  },
  {
    name: "create_reminder",
    description:
      "Cria um lembrete que será disparado no WhatsApp no horário indicado. Use para qualquer 'me lembra de...' ou tarefa com hora marcada.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "O que lembrar (na voz do secretário, ex.: 'Ligar para o contador')." },
        due_at: {
          type: "string",
          description: "Quando disparar, em ISO 8601 com fuso (ex.: 2026-06-23T18:00:00-03:00). Calcule a partir do 'Agora' do contexto.",
        },
      },
      required: ["text", "due_at"],
    },
  },
  {
    name: "list_reminders",
    description: "Lista os lembretes. Por padrão, os em aberto.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "pending, sent, done ou cancelled. Omita para ver os em aberto." },
      },
      required: [],
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancela um lembrete em aberto pelo seu id (mostrado nos lembretes do contexto).",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "id do lembrete (aceita os 6 últimos caracteres)." } },
      required: ["id"],
    },
  },
  {
    name: "complete_reminder",
    description: "Marca um lembrete como concluído pelo seu id.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "id do lembrete (aceita os 6 últimos caracteres)." } },
      required: ["id"],
    },
  },
  {
    name: "list_calendar_events",
    description:
      "Lista eventos da agenda (Google Calendar) entre dois instantes. Use para responder sobre compromissos.",
    input_schema: {
      type: "object",
      properties: {
        time_min: { type: "string", description: "Início do intervalo em ISO 8601 com fuso." },
        time_max: { type: "string", description: "Fim do intervalo em ISO 8601 com fuso." },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    name: "create_calendar_event",
    description: "Cria um evento na agenda (Google Calendar).",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Título do evento." },
        start: { type: "string", description: "Início em ISO 8601 com fuso." },
        end: { type: "string", description: "Fim em ISO 8601 com fuso. Se omitido, dura 1h." },
        description: { type: "string", description: "Detalhes (opcional)." },
        location: { type: "string", description: "Local (opcional)." },
      },
      required: ["summary", "start"],
    },
  },
] as const;

/** Mensagem padrão quando a agenda não está conectada. */
function calendarConnectHint(): string {
  const url = config.PUBLIC_URL ? `${config.PUBLIC_URL}/oauth/google/start` : "(defina PUBLIC_URL)";
  return `A agenda do Google ainda não está conectada. Peça ao dono para abrir este link uma vez para autorizar: ${url}`;
}

function resolveReminderId(short: string, ids: string[]): string | null {
  if (ids.includes(short)) return short;
  const match = ids.find((id) => id.endsWith(short));
  return match ?? null;
}

/** Executa uma ferramenta e devolve uma string para o modelo ler. */
export async function executeTool(name: string, input: any): Promise<string> {
  try {
    switch (name) {
      case "save_memory": {
        await saveFact({
          category: input.category,
          key: input.key,
          value: input.value,
          salience: input.salience,
        });
        return `Memorizado: ${input.key} = ${input.value}`;
      }
      case "forget_memory": {
        const n = await forgetFact(input.key);
        return n > 0 ? `Esquecido: ${input.key}` : `Nada encontrado com a chave ${input.key}.`;
      }
      case "create_reminder": {
        const due = new Date(input.due_at);
        if (isNaN(due.getTime())) return `due_at inválido: "${input.due_at}". Use ISO 8601 com fuso.`;
        const r = await createReminder(input.text, due);
        return `Lembrete criado (id ${r.id.slice(-6)}) para ${fmtLong(due)}: ${input.text}`;
      }
      case "list_reminders": {
        const rows = await listReminders(input?.status);
        return formatReminders(rows);
      }
      case "cancel_reminder": {
        const rows = await listReminders();
        const id = resolveReminderId(input.id, rows.map((r) => r.id));
        if (!id) return `Lembrete ${input.id} não encontrado entre os em aberto.`;
        return (await cancelReminder(id)) ? `Lembrete ${input.id} cancelado.` : `Não consegui cancelar ${input.id}.`;
      }
      case "complete_reminder": {
        const rows = await listReminders();
        const id = resolveReminderId(input.id, rows.map((r) => r.id));
        if (!id) return `Lembrete ${input.id} não encontrado.`;
        return (await completeReminder(id)) ? `Lembrete ${input.id} concluído.` : `Não consegui concluir ${input.id}.`;
      }
      case "list_calendar_events": {
        const events = await listEvents(input.time_min, input.time_max);
        if (events.length === 0) return "Nenhum evento nesse período.";
        return events.map((e) => `• ${e.start} → ${e.summary}${e.location ? ` (${e.location})` : ""}`).join("\n");
      }
      case "create_calendar_event": {
        const ev = await createEvent(input);
        return `Evento criado: ${ev.summary} em ${ev.start}.`;
      }
      default:
        return `Ferramenta desconhecida: ${name}`;
    }
  } catch (e) {
    if (e instanceof Error && e.message === "AGENDA_NAO_CONECTADA") return calendarConnectHint();
    log.error(`[tools] erro em ${name}`, e);
    return `Erro ao executar ${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
