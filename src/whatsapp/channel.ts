/**
 * Camada de canal do WhatsApp.
 *
 * O secretário tem duas formas de falar no WhatsApp:
 *  - QR Code (Baileys) — preferida, sem configurar nada na Meta.
 *  - Meta Cloud API — fallback, caso o dono tenha preenchido as credenciais.
 *
 * O pipeline e o agendador falam só com esta camada; ela escolhe o transporte
 * ativo. Assim trocar de um para o outro não toca a lógica de conversa.
 */
import { waConnected, sendTextWA, sendImageWA } from "./baileys";
import * as meta from "./meta";
import { metaReady } from "../services/credentials";

/** Dá para enviar mensagem agora (QR conectado ou Meta configurada)? */
export function canSendWhatsApp(): boolean {
  return waConnected() || metaReady();
}

export async function sendText(to: string, body: string): Promise<void> {
  if (waConnected()) return sendTextWA(to, body);
  return meta.sendText(to, body);
}

export async function sendImage(to: string, imageUrl: string, caption?: string): Promise<void> {
  if (waConnected()) return sendImageWA(to, imageUrl, caption);
  return meta.sendImage(to, imageUrl, caption);
}

export async function markRead(waMessageId: string): Promise<void> {
  if (waConnected()) return; // Baileys já marca como lida na chegada
  return meta.markRead(waMessageId);
}

/** Só a Meta usa mediaId; no Baileys o áudio já chega como buffer no IncomingMessage. */
export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  return meta.downloadMedia(mediaId);
}
