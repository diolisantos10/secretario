/** Transcrição de áudio via OpenAI Whisper. */
import OpenAI from "openai";
import { cred } from "./credentials";

let client: OpenAI | null = null;
let lastKey = "";
function getClient(): OpenAI {
  const key = cred("OPENAI_API_KEY");
  if (!key) throw new Error("Transcrição de áudio requer a chave OpenAI — configure pelo painel em Configurações › Chaves de API.");
  if (!client || lastKey !== key) {
    lastKey = key;
    client = new OpenAI({ apiKey: key });
  }
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
