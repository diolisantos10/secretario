/** Ferramentas do secretário: definições (schema) + execução. */
import { config } from "../config";
import { log } from "../logger";
import { fmtLong } from "../util/datetime";
import { saveFact, forgetFact } from "../services/memory";
import { generateImage } from "../services/imageGen";
import {
  createReminder,
  listReminders,
  cancelReminder,
  completeReminder,
  formatReminders,
} from "../services/reminders";
import { listEvents, createEvent } from "../services/calendar";
import { listRecent, readEmail, sendEmail } from "../services/gmail";
import { createList, addItems, setDone, removeItems, archiveList, getList, allLists, findList } from "../services/lists";
import { readWebpage } from "../services/webreader";

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
  {
    name: "generate_image",
    description:
      "Gera uma imagem com DALL-E 3 (OpenAI) a partir de uma descrição em texto. Use quando o dono pedir para criar, desenhar ou gerar uma imagem. A imagem é enviada diretamente para o WhatsApp (ou exibida no painel).",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Descrição detalhada da imagem em inglês, sendo específico sobre estilo, composição e detalhes visuais.",
        },
        caption: {
          type: "string",
          description: "Legenda curta em português para enviar junto com a imagem. Opcional.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "read_webpage",
    description:
      "Abre um link (URL) e lê o conteúdo da página, devolvendo o texto principal. Use SEMPRE que o dono mandar um link e quiser que você leia, resuma, comente ou extraia algo dele — notícias, artigos, posts, produtos, documentos. Funciona também para muitas páginas de redes sociais. Para perguntas gerais sem um link específico, prefira a busca na web.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "O endereço da página a ler (ex.: https://...)." },
      },
      required: ["url"],
    },
  },
  {
    name: "list_emails",
    description:
      "Lista e-mails recentes da caixa do dono (Gmail). Use para 'tenho e-mail novo?', 'o que chegou?', resumir a caixa de entrada. Aceita a sintaxe de busca do Gmail no campo query.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Busca no estilo Gmail. Padrão 'in:inbox'. Ex.: 'is:unread', 'from:banco', 'newer_than:2d', 'subject:nota fiscal'.",
        },
        max: { type: "integer", description: "Quantos trazer (máx 25). Padrão 10." },
      },
      required: [],
    },
  },
  {
    name: "read_email",
    description:
      "Lê o conteúdo completo de um e-mail pelo seu id (vindo de list_emails). Marca como lido. Use antes de resumir ou responder um e-mail específico.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "id do e-mail (do list_emails)." } },
      required: ["id"],
    },
  },
  {
    name: "send_email",
    description:
      "Envia um e-mail em nome do dono (Gmail). Confirme com o dono antes de enviar se o conteúdo for sensível ou para terceiros importantes. Escreve em texto simples.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destinatário(s), separados por vírgula." },
        subject: { type: "string", description: "Assunto." },
        body: { type: "string", description: "Corpo do e-mail (texto)." },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "create_list",
    description:
      "Cria uma lista/coleção (compras, tarefas de um projeto, ideias, etapas de um plano, livros, o que for). É a forma de 'montar' qualquer organização que o dono pedir — um Trello, um checklist, um quadro. Se a lista já existir pelo nome, reaproveita. Aparece automaticamente como um card no painel.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome da lista (ex.: 'Compras', 'Lançamento do site', 'Ideias de vídeo')." },
        kind: {
          type: "string",
          description: "checklist (itens checáveis, padrão), notes (anotações) ou board (etapas/colunas). Use checklist na dúvida.",
        },
        emoji: { type: "string", description: "Um emoji para o card. Opcional." },
        items: { type: "array", items: { type: "string" }, description: "Itens iniciais. Opcional." },
      },
      required: ["name"],
    },
  },
  {
    name: "add_to_list",
    description: "Adiciona itens a uma lista existente (pelo nome ou pelos últimos 6 chars do id). Cria a lista se não existir.",
    input_schema: {
      type: "object",
      properties: {
        list: { type: "string", description: "Nome ou id curto da lista." },
        items: { type: "array", items: { type: "string" }, description: "Itens a adicionar." },
      },
      required: ["list", "items"],
    },
  },
  {
    name: "check_list_items",
    description: "Marca itens de uma lista como feitos (ou desmarca). Encontra os itens por trecho do texto.",
    input_schema: {
      type: "object",
      properties: {
        list: { type: "string", description: "Nome ou id curto da lista." },
        items: { type: "array", items: { type: "string" }, description: "Itens a marcar (trecho do texto basta)." },
        done: { type: "boolean", description: "true marca como feito (padrão), false desmarca." },
      },
      required: ["list", "items"],
    },
  },
  {
    name: "remove_list_items",
    description: "Remove itens de uma lista (por trecho do texto).",
    input_schema: {
      type: "object",
      properties: {
        list: { type: "string", description: "Nome ou id curto da lista." },
        items: { type: "array", items: { type: "string" }, description: "Itens a remover." },
      },
      required: ["list", "items"],
    },
  },
  {
    name: "view_lists",
    description:
      "Mostra as listas. Sem argumento, lista todas com um resumo. Com 'list', mostra os itens daquela lista. Use para responder 'o que tem na lista de compras?'.",
    input_schema: {
      type: "object",
      properties: { list: { type: "string", description: "Nome ou id curto de uma lista específica. Opcional." } },
      required: [],
    },
  },
  {
    name: "archive_list",
    description: "Arquiva uma lista concluída ou que não é mais necessária (some do painel).",
    input_schema: {
      type: "object",
      properties: { list: { type: "string", description: "Nome ou id curto da lista." } },
      required: ["list"],
    },
  },
] as const;

/** Mensagem padrão quando o Google (agenda/e-mail) não está conectado. */
function calendarConnectHint(what = "a agenda"): string {
  const url = config.PUBLIC_URL ? `${config.PUBLIC_URL}/oauth/google/start` : "(defina PUBLIC_URL)";
  return `O Google ainda não está conectado, então ${what} não está disponível. Peça ao dono para conectar uma vez no painel (Integrações › Google), ou abrir este link: ${url}`;
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
      case "generate_image": {
        const url = await generateImage(input.prompt);
        const caption = (input.caption ?? "").trim();
        return `IMAGE_GENERATED::${url}::${caption}`;
      }
      case "read_webpage": {
        const page = await readWebpage(input.url);
        const head = page.title ? `Título: ${page.title}\n` : "";
        return `${head}URL: ${page.url}\n\n${page.text}`;
      }
      case "list_emails": {
        const emails = await listRecent(input.query || "in:inbox", input.max || 10);
        if (!emails.length) return "Nenhum e-mail encontrado para esse filtro.";
        return emails
          .map((e) => `• [${e.id.slice(-8)}]${e.unread ? " (novo)" : ""} ${e.from} — ${e.subject}\n   ${e.snippet}`)
          .join("\n");
      }
      case "read_email": {
        const e = await readEmail(input.id);
        return `De: ${e.from}\nAssunto: ${e.subject}\nData: ${e.date}\n\n${e.body}`;
      }
      case "send_email": {
        await sendEmail(input.to, input.subject, input.body);
        return `E-mail enviado para ${input.to} — assunto: ${input.subject}`;
      }
      case "create_list": {
        const l = await createList({ name: input.name, kind: input.kind, emoji: input.emoji, items: input.items });
        return `Lista "${l.name}" pronta (id ${l.id.slice(-6)}) com ${l.items.length} item(ns). Aparece no painel.`;
      }
      case "add_to_list": {
        const found = await findList(input.list);
        if (!found) {
          const l = await createList({ name: input.list, items: input.items });
          return `Lista "${l.name}" criada com ${l.items.length} item(ns).`;
        }
        const n = await addItems(found.id, input.items || []);
        return `Adicionei ${n} item(ns) em "${found.name}".`;
      }
      case "check_list_items": {
        const found = await findList(input.list);
        if (!found) return `Lista "${input.list}" não encontrada.`;
        const done = input.done !== false;
        const n = await setDone(found.id, input.items || [], done);
        return `${n} item(ns) ${done ? "marcado(s) como feito" : "desmarcado(s)"} em "${found.name}".`;
      }
      case "remove_list_items": {
        const found = await findList(input.list);
        if (!found) return `Lista "${input.list}" não encontrada.`;
        const n = await removeItems(found.id, input.items || []);
        return `${n} item(ns) removido(s) de "${found.name}".`;
      }
      case "view_lists": {
        if (input.list) {
          const found = await findList(input.list);
          if (!found) return `Lista "${input.list}" não encontrada.`;
          const l = await getList(found.id);
          if (!l) return `Lista "${input.list}" não encontrada.`;
          if (!l.items.length) return `"${l.name}" está vazia.`;
          return `${l.emoji ? l.emoji + " " : ""}${l.name}:\n` + l.items.map((i) => `${i.done ? "✓" : "☐"} ${i.text}`).join("\n");
        }
        const lists = await allLists();
        if (!lists.length) return "Nenhuma lista criada ainda.";
        return lists
          .map((l) => {
            const open = l.items.filter((i) => !i.done).length;
            return `${l.emoji ? l.emoji + " " : ""}${l.name} (id ${l.id.slice(-6)}) — ${open}/${l.items.length} em aberto`;
          })
          .join("\n");
      }
      case "archive_list": {
        const found = await findList(input.list);
        if (!found) return `Lista "${input.list}" não encontrada.`;
        await archiveList(found.id);
        return `Lista "${found.name}" arquivada.`;
      }
      default:
        return `Ferramenta desconhecida: ${name}`;
    }
  } catch (e) {
    if (e instanceof Error && e.message === "AGENDA_NAO_CONECTADA") return calendarConnectHint();
    if (e instanceof Error && e.message === "EMAIL_NAO_CONECTADO") return calendarConnectHint("o e-mail");
    log.error(`[tools] erro em ${name}`, e);
    return `Erro ao executar ${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
