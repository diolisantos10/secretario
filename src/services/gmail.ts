/** Operações de e-mail (Gmail) — usa o mesmo OAuth do Google (googleAuth). */
import { google } from "googleapis";
import { authedClient } from "./googleAuth";

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
}

function header(headers: any[], name: string): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

/** Decodifica o corpo (base64url) de uma parte da mensagem. */
function decodeBody(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

/** Extrai o texto legível de um payload (prefere text/plain, cai para text/html limpo). */
function extractText(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data && (!payload.mimeType || payload.mimeType.startsWith("text/"))) {
    const raw = decodeBody(payload.body.data);
    return payload.mimeType === "text/html" ? stripHtml(raw) : raw;
  }
  const parts: any[] = payload.parts ?? [];
  const plain = parts.find((p) => p.mimeType === "text/plain");
  if (plain?.body?.data) return decodeBody(plain.body.data);
  const html = parts.find((p) => p.mimeType === "text/html");
  if (html?.body?.data) return stripHtml(decodeBody(html.body.data));
  // Multipart aninhado: tenta recursivamente.
  for (const p of parts) {
    const t = extractText(p);
    if (t) return t;
  }
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Lista e-mails recentes que casam com a query (sintaxe de busca do Gmail). */
export async function listRecent(query = "in:inbox", max = 10): Promise<EmailSummary[]> {
  const auth = await authedClient();
  if (!auth) throw new Error("EMAIL_NAO_CONECTADO");
  const gmail = google.gmail({ version: "v1", auth });
  const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: Math.min(max, 25) });
  const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  const out: EmailSummary[] = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const headers = msg.data.payload?.headers ?? [];
    out.push({
      id,
      from: header(headers, "From"),
      subject: header(headers, "Subject") || "(sem assunto)",
      snippet: msg.data.snippet ?? "",
      date: header(headers, "Date"),
      unread: (msg.data.labelIds ?? []).includes("UNREAD"),
    });
  }
  return out;
}

/** Lê um e-mail completo (corpo em texto). */
export async function readEmail(id: string): Promise<{ from: string; subject: string; date: string; body: string }> {
  const auth = await authedClient();
  if (!auth) throw new Error("EMAIL_NAO_CONECTADO");
  const gmail = google.gmail({ version: "v1", auth });
  const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const headers = msg.data.payload?.headers ?? [];
  const body = extractText(msg.data.payload).slice(0, 6000);
  // Marca como lido ao abrir.
  await gmail.users.messages.modify({ userId: "me", id, requestBody: { removeLabelIds: ["UNREAD"] } }).catch(() => {});
  return {
    from: header(headers, "From"),
    subject: header(headers, "Subject") || "(sem assunto)",
    date: header(headers, "Date"),
    body: body || msg.data.snippet || "(sem conteúdo de texto)",
  };
}

/** Envia um e-mail simples (texto). `to` pode ter vários separados por vírgula. */
export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const auth = await authedClient();
  if (!auth) throw new Error("EMAIL_NAO_CONECTADO");
  const gmail = google.gmail({ version: "v1", auth });
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ];
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}

/** Codifica assunto não-ASCII conforme RFC 2047 (para acentos no Subject). */
function encodeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}
