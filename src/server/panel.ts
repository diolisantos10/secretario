/**
 * Painel web (/painel) — cockpit do secretário e interface de testes.
 *
 * Para que serve:
 *  - Conversar com o secretário pelo navegador (mesmo cérebro do WhatsApp), sem
 *    precisar configurar a Meta. Só exige DATABASE_URL + ANTHROPIC_API_KEY.
 *  - Ver e editar a memória de longo prazo, os lembretes, a agenda de hoje e o uso/custo.
 *
 * Segurança: single-owner. O painel só liga se PANEL_PASSWORD estiver definida.
 * Login por senha → cookie de sessão assinado (HMAC da senha). Sem multiusuário.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  config,
  panelReady,
  anthropicReady,
  metaReady,
  googleReady,
} from "../config";
import { log } from "../logger";
import { prisma } from "../db";
import { loadFacts, saveFact, forgetFact } from "../services/memory";
import {
  listReminders,
  createReminder,
  cancelReminder,
  completeReminder,
} from "../services/reminders";
import { listToday, isConnected as calendarConnected } from "../services/calendar";
import { runDirectTurn } from "../pipeline";
import { fmtShort } from "../util/datetime";

const COOKIE = "secretario_panel";
const SESSION_DAYS = 30;

// ---------------------------------------------------------------------------
// Autenticação (mínima, single-owner)
// ---------------------------------------------------------------------------

/** Token de sessão derivado da senha — quem não sabe a senha não consegue forjar. */
function sessionToken(): string {
  return crypto
    .createHmac("sha256", config.PANEL_PASSWORD || "")
    .update("secretario-panel-v1")
    .digest("base64url");
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function passwordMatches(input: string): boolean {
  if (!config.PANEL_PASSWORD) return false;
  const a = crypto.createHash("sha256").update(input).digest();
  const b = crypto.createHash("sha256").update(config.PANEL_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function isAuthed(req: FastifyRequest): boolean {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return Boolean(token) && safeEqual(token, sessionToken());
}

function buildCookie(value: string, maxAgeSec: number): string {
  const secure = (config.PUBLIC_URL || "").startsWith("https") ? "; Secure" : "";
  return `${COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

/** Guarda das rotas de API. Retorna true se pode prosseguir. */
function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!panelReady()) {
    reply.code(503).send({ ok: false, error: "Painel desativado: defina PANEL_PASSWORD." });
    return false;
  }
  if (!isAuthed(req)) {
    reply.code(401).send({ ok: false, error: "Não autenticado." });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

export async function registerPanel(app: FastifyInstance): Promise<void> {
  // Página principal: login ou dashboard.
  app.get("/painel", async (req, reply) => {
    if (!panelReady()) {
      return reply
        .type("text/html")
        .send(shell("Painel desativado", "<p>Defina <code>PANEL_PASSWORD</code> nas variáveis de ambiente para habilitar o painel.</p>"));
    }
    return reply.type("text/html").send(isAuthed(req) ? dashboardPage() : loginPage());
  });

  app.post("/painel/login", async (req, reply) => {
    if (!panelReady()) return reply.code(503).send({ ok: false, error: "Painel desativado." });
    const body = (req.body ?? {}) as { password?: string };
    if (!passwordMatches(body.password ?? "")) {
      return reply.code(401).send({ ok: false, error: "Senha incorreta." });
    }
    reply.header("Set-Cookie", buildCookie(sessionToken(), SESSION_DAYS * 86400));
    return reply.send({ ok: true });
  });

  app.post("/painel/logout", async (_req, reply) => {
    reply.header("Set-Cookie", buildCookie("", 0));
    return reply.send({ ok: true });
  });

  // Estado completo do painel.
  app.get("/painel/api/state", async (req, reply) => {
    if (!guard(req, reply)) return;

    const [facts, reminders, usage, messages] = await Promise.all([
      loadFacts(),
      listReminders(),
      prisma.aiLog.aggregate({
        _sum: {
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
        },
        _count: true,
      }),
      prisma.message.findMany({
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { role: true, content: true, createdAt: true },
      }),
    ]);

    let calConnected = false;
    let agenda: { start: string; summary: string; location?: string }[] = [];
    try {
      calConnected = await calendarConnected();
      if (calConnected) {
        const events = await listToday();
        agenda = events.map((e) => ({ start: e.start, summary: e.summary, location: e.location }));
      }
    } catch (e) {
      log.debug("[painel] agenda indisponível", e);
    }

    return reply.send({
      ok: true,
      owner: config.OWNER_NAME,
      timezone: config.TIMEZONE,
      readiness: {
        claude: anthropicReady(),
        whatsapp: metaReady(),
        googleConfigured: googleReady(),
        calendarConnected: calConnected,
      },
      facts,
      reminders: reminders.map((r) => ({
        id: r.id,
        text: r.text,
        status: r.status,
        dueAt: r.dueAt,
        due: fmtShort(r.dueAt),
      })),
      agenda,
      calendarConnected: calConnected,
      usage: {
        calls: usage._count,
        inputTokens: usage._sum.inputTokens ?? 0,
        outputTokens: usage._sum.outputTokens ?? 0,
        cacheReadTokens: usage._sum.cacheReadTokens ?? 0,
        cacheWriteTokens: usage._sum.cacheWriteTokens ?? 0,
      },
      messages: messages.reverse(),
    });
  });

  // Chat de teste — fala com o MESMO secretário, sem mandar WhatsApp.
  app.post("/painel/api/chat", async (req, reply) => {
    if (!guard(req, reply)) return;
    if (!anthropicReady()) {
      return reply.send({ ok: false, error: "Claude não configurado — defina ANTHROPIC_API_KEY." });
    }
    const body = (req.body ?? {}) as { text?: string };
    const text = (body.text ?? "").trim();
    if (!text) return reply.send({ ok: false, error: "Mensagem vazia." });
    try {
      const replyText = await runDirectTurn(text);
      return reply.send({ ok: true, reply: replyText });
    } catch (e) {
      log.error("[painel] chat falhou", e);
      return reply.send({ ok: false, error: e instanceof Error ? e.message : "Falha ao responder." });
    }
  });

  // Memória: adicionar/atualizar e esquecer.
  app.post("/painel/api/memory", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as {
      category?: string;
      key?: string;
      value?: string;
      salience?: number;
    };
    if (!body.key?.trim() || !body.value?.trim()) {
      return reply.send({ ok: false, error: "Informe chave e valor." });
    }
    await saveFact({
      category: body.category,
      key: body.key,
      value: body.value,
      salience: body.salience,
    });
    return reply.send({ ok: true });
  });

  app.post("/painel/api/memory/forget", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { key?: string };
    if (!body.key?.trim()) return reply.send({ ok: false, error: "Informe a chave." });
    const n = await forgetFact(body.key);
    return reply.send({ ok: true, removed: n });
  });

  // Lembretes: criar, concluir, cancelar.
  app.post("/painel/api/reminders", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { text?: string; due_at?: string };
    const text = (body.text ?? "").trim();
    const due = new Date(body.due_at ?? "");
    if (!text) return reply.send({ ok: false, error: "Informe o texto do lembrete." });
    if (isNaN(due.getTime())) return reply.send({ ok: false, error: "Data/hora inválida." });
    const r = await createReminder(text, due);
    return reply.send({ ok: true, id: r.id });
  });

  app.post("/painel/api/reminders/done", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { id?: string };
    if (!body.id) return reply.send({ ok: false, error: "Informe o id." });
    const ok = await completeReminder(body.id);
    return reply.send({ ok });
  });

  app.post("/painel/api/reminders/cancel", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { id?: string };
    if (!body.id) return reply.send({ ok: false, error: "Informe o id." });
    const ok = await cancelReminder(body.id);
    return reply.send({ ok });
  });

  log.info("[painel] rotas /painel registradas" + (panelReady() ? "" : " (desativado: defina PANEL_PASSWORD)"));
}

// ---------------------------------------------------------------------------
// HTML (sem build step: página única com CSS/JS embutidos)
// ---------------------------------------------------------------------------

const STYLE = `
  :root{--bg:#0f1115;--card:#181b22;--soft:#1f242d;--line:#2a313c;--fg:#e7ebf0;--mut:#9aa4b2;--acc:#5b8cff;--ok:#36d399;--warn:#fbbd23;--err:#f87272}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  a{color:var(--acc)}
  code{background:var(--soft);padding:1px 5px;border-radius:4px}
  .wrap{max-width:1100px;margin:0 auto;padding:18px}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  header h1{font-size:18px;margin:0;font-weight:650}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
  .chip{font-size:12px;padding:3px 9px;border-radius:999px;background:var(--soft);color:var(--mut);border:1px solid var(--line)}
  .chip.on{color:var(--ok);border-color:#1f4d3a}
  .chip.off{color:var(--mut)}
  .grid{display:grid;grid-template-columns:1.3fr .9fr;gap:16px}
  @media(max-width:820px){.grid{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:16px}
  .card h2{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);margin:0 0 10px}
  .chat{display:flex;flex-direction:column;height:62vh;min-height:380px}
  .log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}
  .msg{max-width:85%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
  .msg.user{align-self:flex-end;background:var(--acc);color:#06122e;border-bottom-right-radius:4px}
  .msg.assistant{align-self:flex-start;background:var(--soft);border-bottom-left-radius:4px}
  .msg .who{display:block;font-size:11px;opacity:.7;margin-bottom:2px}
  .composer{display:flex;gap:8px;margin-top:10px}
  input,textarea,select,button{font:inherit;color:var(--fg);background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:9px 11px}
  input:focus,textarea:focus{outline:2px solid var(--acc);border-color:var(--acc)}
  textarea{resize:none;flex:1}
  button{cursor:pointer;background:var(--acc);color:#06122e;border:none;font-weight:600}
  button.ghost{background:var(--soft);color:var(--fg);border:1px solid var(--line);font-weight:500}
  button.mini{padding:3px 8px;font-size:12px}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .item{padding:8px 0;border-bottom:1px solid var(--line)}
  .item:last-child{border-bottom:none}
  .item .top{display:flex;gap:8px;align-items:baseline;justify-content:space-between}
  .muted{color:var(--mut)}
  .tag{font-size:11px;color:var(--mut);background:var(--soft);padding:1px 7px;border-radius:999px;border:1px solid var(--line)}
  .empty{color:var(--mut);font-style:italic;padding:6px 0}
  form.inline{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
  form.inline input{flex:1;min-width:90px}
  .err{color:var(--err);font-size:13px;min-height:18px}
  .stat{display:flex;justify-content:space-between;padding:3px 0;color:var(--mut)}
  .stat b{color:var(--fg);font-weight:600}
`;

function shell(title: string, body: string): string {
  return (
    "<!doctype html><html lang=\"pt-br\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" + title + "</title><style>" + STYLE + "</style></head>" +
    "<body><div class=\"wrap\">" + body + "</div></body></html>"
  );
}

function loginPage(): string {
  const body =
    "<div class=\"card\" style=\"max-width:420px;margin:12vh auto\">" +
    "<h2>Secretário — Painel</h2>" +
    "<p class=\"muted\">Acesso restrito ao dono.</p>" +
    "<form class=\"inline\" id=\"f\" style=\"flex-direction:column;align-items:stretch\">" +
    "<input id=\"pw\" type=\"password\" placeholder=\"Senha do painel\" autofocus>" +
    "<button>Entrar</button>" +
    "<div class=\"err\" id=\"err\"></div>" +
    "</form></div>" +
    "<script>" +
    "document.getElementById('f').addEventListener('submit',async function(e){" +
    "e.preventDefault();var err=document.getElementById('err');err.textContent='';" +
    "var r=await fetch('/painel/login',{method:'POST',headers:{'content-type':'application/json'}," +
    "body:JSON.stringify({password:document.getElementById('pw').value})});" +
    "var j=await r.json();if(j.ok){location.reload()}else{err.textContent=j.error||'Falha ao entrar.'}" +
    "});" +
    "</script>";
  return shell("Painel — Login", body);
}

function dashboardPage(): string {
  const owner = config.OWNER_NAME;
  const body =
    "<header><h1>Secretário de " + owner + "</h1>" +
    "<div class=\"chips\" id=\"chips\"></div>" +
    "<button class=\"ghost mini\" id=\"logout\">sair</button></header>" +
    "<div class=\"grid\">" +
    // Coluna esquerda: chat
    "<div><div class=\"card chat\">" +
    "<h2>Conversa (teste) — mesmo secretário do WhatsApp</h2>" +
    "<div class=\"log\" id=\"log\"></div>" +
    "<div class=\"composer\">" +
    "<textarea id=\"input\" rows=\"2\" placeholder=\"Fale com seu secretário... (Enter envia)\"></textarea>" +
    "<button id=\"send\">Enviar</button></div>" +
    "<div class=\"err\" id=\"chatErr\"></div>" +
    "</div></div>" +
    // Coluna direita: cards
    "<div>" +
    "<div class=\"card\"><h2>Memória</h2><div id=\"facts\"></div>" +
    "<form class=\"inline\" id=\"fFact\">" +
    "<input id=\"fcat\" placeholder=\"categoria\" style=\"max-width:110px\">" +
    "<input id=\"fkey\" placeholder=\"chave\" style=\"max-width:120px\">" +
    "<input id=\"fval\" placeholder=\"valor\">" +
    "<button class=\"mini\">+</button></form></div>" +

    "<div class=\"card\"><h2>Lembretes</h2><div id=\"reminders\"></div>" +
    "<form class=\"inline\" id=\"fRem\">" +
    "<input id=\"rtext\" placeholder=\"o que lembrar\">" +
    "<input id=\"rwhen\" type=\"datetime-local\">" +
    "<button class=\"mini\">+</button></form></div>" +

    "<div class=\"card\"><h2>Agenda de hoje</h2><div id=\"agenda\"></div></div>" +

    "<div class=\"card\"><h2>Uso (Claude)</h2><div id=\"usage\"></div></div>" +
    "</div>" +
    "</div>" +
    "<script>" + DASH_JS + "</script>";
  return shell("Secretário — Painel", body);
}

// JS do dashboard — sem backticks nem ${...} (vive dentro de template do TS).
const DASH_JS = [
  "var S=null;",
  "function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;}",
  "function api(path,body){return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json();});}",
  // ---- carregar estado ----
  "function load(){return fetch('/painel/api/state').then(function(r){return r.json();}).then(function(s){if(!s.ok)return;S=s;render();});}",
  "function render(){renderChips();renderLog();renderFacts();renderReminders();renderAgenda();renderUsage();}",
  // ---- chips de prontidão ----
  "function renderChips(){var c=document.getElementById('chips');c.innerHTML='';var r=S.readiness;",
  "var defs=[['Claude',r.claude],['WhatsApp',r.whatsapp],['Agenda',r.calendarConnected]];",
  "defs.forEach(function(d){var ch=el('span','chip '+(d[1]?'on':'off'),(d[1]?'● ':'○ ')+d[0]);c.appendChild(ch);});}",
  // ---- chat ----
  "function renderLog(){var l=document.getElementById('log');l.innerHTML='';(S.messages||[]).forEach(function(m){addMsg(m.role,m.content,false);});scrollLog();}",
  "function addMsg(role,text,scroll){var l=document.getElementById('log');var m=el('div','msg '+(role==='user'?'user':'assistant'));var w=el('span','who',role==='user'?S.owner:'secretário');m.appendChild(w);m.appendChild(document.createTextNode(text));l.appendChild(m);if(scroll!==false)scrollLog();}",
  "function scrollLog(){var l=document.getElementById('log');l.scrollTop=l.scrollHeight;}",
  "function send(){var i=document.getElementById('input');var t=i.value.trim();if(!t)return;var err=document.getElementById('chatErr');err.textContent='';i.value='';addMsg('user',t);var b=document.getElementById('send');b.disabled=true;b.textContent='...';",
  "var typing=el('div','msg assistant','escrevendo...');typing.id='typing';document.getElementById('log').appendChild(typing);scrollLog();",
  "api('/painel/api/chat',{text:t}).then(function(j){var tp=document.getElementById('typing');if(tp)tp.remove();b.disabled=false;b.textContent='Enviar';if(j.ok){addMsg('assistant',j.reply);load();}else{err.textContent=j.error||'Falha.';}}).catch(function(){var tp=document.getElementById('typing');if(tp)tp.remove();b.disabled=false;b.textContent='Enviar';err.textContent='Erro de rede.';});}",
  // ---- memória ----
  "function renderFacts(){var box=document.getElementById('facts');box.innerHTML='';var f=S.facts||[];if(!f.length){box.appendChild(el('div','empty','(nada memorizado ainda)'));return;}",
  "f.forEach(function(x){var it=el('div','item');var top=el('div','top');var left=el('div');left.appendChild(el('span','tag',x.category));left.appendChild(document.createTextNode(' '+x.key));var b=el('button','ghost mini','esquecer');b.onclick=function(){api('/painel/api/memory/forget',{key:x.key}).then(load);};top.appendChild(left);top.appendChild(b);it.appendChild(top);it.appendChild(el('div','muted',x.value));box.appendChild(it);});}",
  // ---- lembretes ----
  "function renderReminders(){var box=document.getElementById('reminders');box.innerHTML='';var r=S.reminders||[];if(!r.length){box.appendChild(el('div','empty','(nenhum em aberto)'));return;}",
  "r.forEach(function(x){var it=el('div','item');var top=el('div','top');top.appendChild(el('div',null,x.text));top.appendChild(el('span','tag',x.due));it.appendChild(top);var act=el('div','row');var d=el('button','ghost mini','✓ feito');d.onclick=function(){api('/painel/api/reminders/done',{id:x.id}).then(load);};var c=el('button','ghost mini','cancelar');c.onclick=function(){api('/painel/api/reminders/cancel',{id:x.id}).then(load);};act.appendChild(d);act.appendChild(c);it.appendChild(act);box.appendChild(it);});}",
  // ---- agenda ----
  "function renderAgenda(){var box=document.getElementById('agenda');box.innerHTML='';if(!S.calendarConnected){box.appendChild(el('div','empty','Agenda não conectada. Conecte em /oauth/google/start'));return;}var a=S.agenda||[];if(!a.length){box.appendChild(el('div','empty','(sem eventos hoje)'));return;}a.forEach(function(e){var it=el('div','item');it.appendChild(el('div',null,e.summary));it.appendChild(el('div','muted',e.start+(e.location?(' · '+e.location):'')));box.appendChild(it);});}",
  // ---- uso ----
  "function renderUsage(){var box=document.getElementById('usage');box.innerHTML='';var u=S.usage||{};function row(k,v){var r=el('div','stat');r.appendChild(el('span',null,k));var b=el('b',null,(v||0).toLocaleString('pt-BR'));r.appendChild(b);box.appendChild(r);}row('Chamadas',u.calls);row('Tokens entrada',u.inputTokens);row('Tokens saída',u.outputTokens);row('Cache (leitura)',u.cacheReadTokens);}",
  // ---- wiring ----
  "document.getElementById('send').addEventListener('click',send);",
  "document.getElementById('input').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});",
  "document.getElementById('logout').addEventListener('click',function(){api('/painel/logout',{}).then(function(){location.reload();});});",
  "document.getElementById('fFact').addEventListener('submit',function(e){e.preventDefault();var k=document.getElementById('fkey').value.trim();var v=document.getElementById('fval').value.trim();if(!k||!v)return;api('/painel/api/memory',{category:document.getElementById('fcat').value.trim()||'geral',key:k,value:v}).then(function(){document.getElementById('fcat').value='';document.getElementById('fkey').value='';document.getElementById('fval').value='';load();});});",
  "document.getElementById('fRem').addEventListener('submit',function(e){e.preventDefault();var t=document.getElementById('rtext').value.trim();var w=document.getElementById('rwhen').value;if(!t||!w)return;api('/painel/api/reminders',{text:t,due_at:new Date(w).toISOString()}).then(function(){document.getElementById('rtext').value='';document.getElementById('rwhen').value='';load();});});",
  "load();setInterval(load,30000);",
].join("\n");
