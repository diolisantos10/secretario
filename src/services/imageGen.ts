/** Geração de imagens com DALL-E 3 (OpenAI). */
import OpenAI from "openai";
import { config } from "../config";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!config.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurado.");
  if (!client) client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  return client;
}

/** Gera uma imagem e retorna a URL temporária do DALL-E (válida ~1h). */
export async function generateImage(prompt: string): Promise<string> {
  const c = getClient();
  const response = await c.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
  });
  const url = response.data?.[0]?.url;
  if (!url) throw new Error("DALL-E não retornou URL de imagem.");
  return url;
}
