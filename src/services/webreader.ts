/**
 * Leitura de páginas web — baixa uma URL e devolve o texto principal limpo.
 *
 * Estratégia: tenta o fetch direto (rápido, cobre notícias, blogs, artigos,
 * Wikipedia, docs). Se o resultado vier vazio/bloqueado (comum em páginas que
 * dependem de JavaScript, como redes sociais), cai para o Jina Reader, um
 * serviço gratuito que renderiza a página e devolve texto limpo.
 */
import { log } from "../logger";

const MAX_CHARS = 9000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface PageContent {
  url: string;
  title: string;
  text: string;
  via: "direto" | "leitor";
}

/** Normaliza e valida a URL; bloqueia destinos internos (anti-SSRF básico). */
function normalizeUrl(raw: string): string {
  let s = (raw || "").trim();
  if (!s) throw new Error("URL vazia.");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error("Endereço interno não é permitido.");
  }
  return u.toString();
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
  mdash: "—", ndash: "–", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', eacute: "é",
};
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Extrai título + texto legível de um HTML, descartando script/estilo/navegação. */
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : "";

  let body = html;
  // Remove blocos sem conteúdo útil.
  body = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|nav|footer|form|aside|template|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Quebras de linha em elementos de bloco.
  body = body
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  // Tira todas as tags restantes.
  body = body.replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);
  // Colapsa espaços e linhas em branco.
  body = body
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: body };
}

function clamp(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + "\n\n[…conteúdo truncado…]";
}

async function fetchDireto(url: string): Promise<PageContent | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log.debug(`[webreader] direto HTTP ${res.status} em ${url}`);
      return null;
    }
    const ct = res.headers.get("content-type") || "";
    const raw = await res.text();
    if (!/html|xml|text\/plain/i.test(ct)) {
      // Não é página: devolve um aviso do tipo de conteúdo.
      return { url, title: "", text: `(conteúdo não-textual: ${ct || "desconhecido"})`, via: "direto" };
    }
    const { title, text } = htmlToText(raw);
    if (text.length < 200) return null; // provavelmente bloqueado/JS — tenta o leitor
    return { url, title, text: clamp(text), via: "direto" };
  } catch (e) {
    log.debug(`[webreader] falha no fetch direto de ${url}`, e);
    return null;
  }
}

async function fetchLeitor(url: string): Promise<PageContent | null> {
  try {
    const res = await fetch("https://r.jina.ai/" + url, {
      headers: { "User-Agent": UA, "X-Return-Format": "text" },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      log.debug(`[webreader] leitor HTTP ${res.status} em ${url}`);
      return null;
    }
    const text = (await res.text()).trim();
    if (!text) return null;
    return { url, title: "", text: clamp(text), via: "leitor" };
  } catch (e) {
    log.debug(`[webreader] falha no leitor de ${url}`, e);
    return null;
  }
}

/** Lê uma página e devolve o conteúdo. Lança erro amigável se não conseguir. */
export async function readWebpage(rawUrl: string): Promise<PageContent> {
  const url = normalizeUrl(rawUrl);
  const direto = await fetchDireto(url);
  if (direto) return direto;
  const leitor = await fetchLeitor(url);
  if (leitor) return leitor;
  throw new Error(
    "Não consegui ler essa página — ela pode exigir login, estar fora do ar ou bloquear leitura automática.",
  );
}
