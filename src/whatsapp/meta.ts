/**
 * Meta WhatsApp Cloud API — envio e parsing de entrada.
 *
 * Enviar:  POST graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages (Bearer token).
 * Receber: o webhook entrega entry[].changes[].value.messages[]; aqui só normalizamos.
 */
import { requireMeta } from "../config";
import { log } from "../logger";
import { digits } from "../util/phone";

const WA_TEXT_LIMIT = 4000; // limite da Meta é ~4096; deixamos folga

export interface IncomingMessage {
  from: string; // telefone do remetente (dígitos)
  waMessageId: string; // wamid
  type: string; // text | image | audio | ...
  text: string; // corpo (vazio se não-texto)
  timestamp: Date;
  profileName: string | null;
  phoneNumberId: string | null;
  audioMediaId?: string; // preenchido quando type === "audio"
  audioMimeType?: string;
}

function graphUrl(path: string): string {
  const { graphVersion } = requireMeta();
  return `https://graph.facebook.com/${graphVersion}/${path}`;
}

/** Quebra textos longos em pedaços que cabem numa mensagem de WhatsApp. */
function chunk(text: string, size = WA_TEXT_LIMIT): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Envia texto ao destinatário (default: ao dono). Lança em falha definitiva. */
export async function sendText(to: string, body: string): Promise<void> {
  const { phoneNumberId, accessToken } = requireMeta();
  const recipient = digits(to);
  for (const part of chunk(body)) {
    const res = await fetch(graphUrl(`${phoneNumberId}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { preview_url: true, body: part },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      log.error(`[meta] envio falhou (HTTP ${res.status})`, detail.slice(0, 500));
      throw new Error(`Falha ao enviar WhatsApp: HTTP ${res.status}`);
    }
  }
}

/** Envia uma imagem por URL ao destinatário (default: ao dono). */
export async function sendImage(to: string, imageUrl: string, caption?: string): Promise<void> {
  const { phoneNumberId, accessToken } = requireMeta();
  const recipient = digits(to);
  const body: any = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "image",
    image: { link: imageUrl },
  };
  if (caption) body.image.caption = caption;
  const res = await fetch(graphUrl(`${phoneNumberId}/messages`), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    log.error(`[meta] envio de imagem falhou (HTTP ${res.status})`, detail.slice(0, 500));
    throw new Error(`Falha ao enviar imagem WhatsApp: HTTP ${res.status}`);
  }
}

/** Marca uma mensagem recebida como lida (✓✓ azul). Best-effort. */
export async function markRead(waMessageId: string): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = requireMeta();
    await fetch(graphUrl(`${phoneNumberId}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: waMessageId }),
    });
  } catch (e) {
    log.debug("[meta] markRead falhou (ignorado)", e);
  }
}

/**
 * Baixa uma mídia (áudio, imagem…) da Meta pelo ID.
 * Primeiro busca a URL temporária, depois faz o download do binário.
 */
export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const { accessToken, graphVersion } = requireMeta();
  const metaRes = await fetch(`https://graph.facebook.com/${graphVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) throw new Error(`Falha ao obter URL da mídia: HTTP ${metaRes.status}`);
  const { url, mime_type } = (await metaRes.json()) as { url: string; mime_type: string };

  const mediaRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!mediaRes.ok) throw new Error(`Falha ao baixar mídia: HTTP ${mediaRes.status}`);

  const buffer = Buffer.from(await mediaRes.arrayBuffer());
  return { buffer, mimeType: mime_type ?? "audio/ogg" };
}

/** Extrai as mensagens de texto de um payload de webhook da Meta. */
export function parseIncoming(payload: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const entries = (payload as any)?.entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const phoneNumberId: string | null = value?.metadata?.phone_number_id ?? null;
      const contacts: any[] = value?.contacts ?? [];
      const profileByWa = new Map<string, string>();
      for (const c of contacts) {
        if (c?.wa_id) profileByWa.set(String(c.wa_id), c?.profile?.name ?? "");
      }
      for (const m of value?.messages ?? []) {
        const from = String(m?.from ?? "");
        const tsSec = Number(m?.timestamp ?? 0);
        out.push({
          from,
          waMessageId: String(m?.id ?? ""),
          type: String(m?.type ?? "unknown"),
          text: m?.text?.body ?? m?.button?.text ?? m?.interactive?.list_reply?.title ?? "",
          timestamp: tsSec ? new Date(tsSec * 1000) : new Date(),
          profileName: profileByWa.get(from) || null,
          phoneNumberId,
          audioMediaId: m?.audio?.id ?? undefined,
          audioMimeType: m?.audio?.mime_type ?? undefined,
        });
      }
    }
  }
  return out;
}
