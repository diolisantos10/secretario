/** Transcrição de áudio via OpenAI Whisper. */
import OpenAI from "openai";
import { config } from "../config";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!config.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurado.");
  if (!client) client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  return client;
}

function extFromMime(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  return "ogg";
}

/** Transcreve um buffer de áudio e retorna o texto em português. */
export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  const c = getClient();
  const ext = extFromMime(mimeType);
  const file = new File([buffer], `audio.${ext}`, { type: mimeType.split(";")[0] });
  const response = await c.audio.transcriptions.create({
    model: "whisper-1",
    file,
    language: "pt",
  });
  return response.text.trim();
}
