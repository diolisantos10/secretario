import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config, panelReady, anthropicReady, openaiReady } from "../config";
import { cred, setCredentials, metaReady, googleReady } from "../services/credentials";
import { waStatus, startWhatsApp, logoutWhatsApp, waConnected } from "../whatsapp/baileys";
import { log } from "../logger";
import { prisma } from "../db";
import { loadFacts, saveFact, forgetFact } from "../services/memory";
import { listReminders, createReminder, cancelReminder, completeReminder } from "../services/reminders";
import { listToday, isConnected as calendarConnected } from "../services/calendar";
import { runDirectTurn } from "../pipeline";
import { fmtShort } from "../util/datetime";

const COOKIE = "secretario_panel";
const SESSION_DAYS = 30;

function sessionToken(): string {
  return crypto.createHmac("sha256", config.PANEL_PASSWORD || "").update("secretario-panel-v1").digest("base64url");
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
function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!panelReady()) { reply.code(503).send({ ok: false, error: "Painel desativado." }); return false; }
  if (!isAuthed(req)) { reply.code(401).send({ ok: false, error: "Não autenticado." }); return false; }
  return true;
}

export async function registerPanel(app: FastifyInstance): Promise<void> {
  app.get("/painel", async (req, reply) => {
    if (!panelReady()) return reply.type("text/html").send(shell("Painel desativado", "<p>Defina <code>PANEL_PASSWORD</code> para habilitar o painel.</p>"));
    return reply.type("text/html").send(isAuthed(req) ? dashboardPage() : loginPage());
  });

  app.post("/painel/login", async (req, reply) => {
    if (!panelReady()) return reply.code(503).send({ ok: false, error: "Painel desativado." });
    const body = (req.body ?? {}) as { password?: string };
    if (!passwordMatches(body.password ?? "")) return reply.code(401).send({ ok: false, error: "Senha incorreta." });
    reply.header("Set-Cookie", buildCookie(sessionToken(), SESSION_DAYS * 86400));
    return reply.send({ ok: true });
  });

  app.post("/painel/logout", async (_req, reply) => {
    reply.header("Set-Cookie", buildCookie("", 0));
    return reply.send({ ok: true });
  });

  app.get("/painel/api/state", async (req, reply) => {
    if (!guard(req, reply)) return;

    // Auto-generate verify token for WhatsApp if missing
    let verifyToken = cred("META_VERIFY_TOKEN");
    if (!verifyToken) {
      verifyToken = crypto.randomBytes(12).toString("hex");
      try { await setCredentials({ META_VERIFY_TOKEN: verifyToken }); } catch {}
    }

    const [facts, reminders, usage, messages] = await Promise.all([
      loadFacts(),
      listReminders(),
      prisma.aiLog.aggregate({ _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true }, _count: true }),
      prisma.message.findMany({ orderBy: { createdAt: "desc" }, take: 30, select: { role: true, content: true, createdAt: true } }),
    ]);

    let calConnected = false;
    let agenda: { start: string; summary: string; location?: string }[] = [];
    try {
      calConnected = await calendarConnected();
      if (calConnected) {
        const events = await listToday();
        agenda = events.map((e) => ({ start: e.start, summary: e.summary, location: e.location }));
      }
    } catch (e) { log.debug("[painel] agenda indisponível", e); }

    const publicUrl = config.PUBLIC_URL || "";
    return reply.send({
      ok: true,
      owner: config.OWNER_NAME,
      readiness: { claude: anthropicReady(), openai: openaiReady(), whatsapp: waConnected() || metaReady(), calendarConnected: calConnected },
      integrations: {
        publicUrl,
        google: {
          configured: googleReady(),
          connected: calConnected,
          clientId: cred("GOOGLE_CLIENT_ID"),
          redirectUri: cred("GOOGLE_REDIRECT_URI") || (publicUrl ? publicUrl + "/oauth/google/callback" : ""),
        },
        whatsapp: {
          configured: metaReady(),
          webhookUrl: publicUrl ? publicUrl + "/webhook/meta" : "",
          verifyToken,
          phoneNumberId: cred("META_PHONE_NUMBER_ID"),
          ownerWhatsapp: cred("OWNER_WHATSAPP"),
        },
      },
      facts,
      reminders: reminders.map((r) => ({ id: r.id, text: r.text, status: r.status, dueAt: r.dueAt, due: fmtShort(r.dueAt) })),
      agenda,
      usage: { calls: usage._count, inputTokens: usage._sum.inputTokens ?? 0, outputTokens: usage._sum.outputTokens ?? 0, cacheReadTokens: usage._sum.cacheReadTokens ?? 0, cacheWriteTokens: usage._sum.cacheWriteTokens ?? 0 },
      messages: messages.reverse(),
    });
  });

  app.post("/painel/api/chat", async (req, reply) => {
    if (!guard(req, reply)) return;
    if (!anthropicReady()) return reply.send({ ok: false, error: "Claude não configurado — defina ANTHROPIC_API_KEY." });
    const body = (req.body ?? {}) as { text?: string };
    const text = (body.text ?? "").trim();
    if (!text) return reply.send({ ok: false, error: "Mensagem vazia." });
    try {
      const result = await runDirectTurn(text);
      return reply.send({ ok: true, reply: result.text, imageUrl: result.imageUrl ?? null, imageCaption: result.imageCaption ?? null });
    } catch (e) {
      log.error("[painel] chat falhou", e);
      return reply.send({ ok: false, error: e instanceof Error ? e.message : "Falha ao responder." });
    }
  });

  app.post("/painel/api/memory", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { category?: string; key?: string; value?: string; salience?: number };
    if (!body.key?.trim() || !body.value?.trim()) return reply.send({ ok: false, error: "Informe chave e valor." });
    await saveFact({ category: body.category, key: body.key, value: body.value, salience: body.salience });
    return reply.send({ ok: true });
  });

  app.post("/painel/api/memory/forget", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { key?: string };
    if (!body.key?.trim()) return reply.send({ ok: false, error: "Informe a chave." });
    const n = await forgetFact(body.key);
    return reply.send({ ok: true, removed: n });
  });

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
    return reply.send({ ok: await completeReminder(body.id) });
  });

  app.post("/painel/api/reminders/cancel", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { id?: string };
    if (!body.id) return reply.send({ ok: false, error: "Informe o id." });
    return reply.send({ ok: await cancelReminder(body.id) });
  });

  app.post("/painel/api/integrations/google", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { clientId?: string; clientSecret?: string };
    const clientId = (body.clientId ?? "").trim();
    const clientSecret = (body.clientSecret ?? "").trim();
    if (!clientId || !clientSecret) return reply.send({ ok: false, error: "Informe o Client ID e o Client Secret." });
    const redirectUri = config.PUBLIC_URL ? config.PUBLIC_URL + "/oauth/google/callback" : cred("GOOGLE_REDIRECT_URI");
    if (!redirectUri) return reply.send({ ok: false, error: "Defina a PUBLIC_URL do serviço primeiro." });
    await setCredentials({ GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REDIRECT_URI: redirectUri });
    return reply.send({ ok: true });
  });

  app.post("/painel/api/integrations/google/disconnect", async (req, reply) => {
    if (!guard(req, reply)) return;
    await prisma.googleToken.deleteMany({});
    return reply.send({ ok: true });
  });

  app.post("/painel/api/integrations/whatsapp", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { phoneNumberId?: string; accessToken?: string; appSecret?: string; verifyToken?: string; ownerWhatsapp?: string };
    const phoneNumberId = (body.phoneNumberId ?? "").trim();
    const accessToken = (body.accessToken ?? "").trim();
    if (!phoneNumberId || !accessToken) return reply.send({ ok: false, error: "Phone Number ID e Access Token são obrigatórios." });
    const existing = cred("META_VERIFY_TOKEN");
    await setCredentials({
      META_PHONE_NUMBER_ID: phoneNumberId,
      META_ACCESS_TOKEN: accessToken,
      META_APP_SECRET: (body.appSecret ?? "").trim(),
      META_VERIFY_TOKEN: (body.verifyToken ?? "").trim() || existing || crypto.randomBytes(12).toString("hex"),
      OWNER_WHATSAPP: (body.ownerWhatsapp ?? "").trim().replace(/\D/g, ""),
    });
    return reply.send({ ok: true });
  });

  app.post("/painel/api/integrations/whatsapp/disconnect", async (req, reply) => {
    if (!guard(req, reply)) return;
    await setCredentials({ META_PHONE_NUMBER_ID: "", META_ACCESS_TOKEN: "", META_APP_SECRET: "" });
    return reply.send({ ok: true });
  });

  // WhatsApp via QR Code (Baileys) — conectar/estado/desconectar.
  app.get("/painel/api/whatsapp/status", async (req, reply) => {
    if (!guard(req, reply)) return;
    const st = waStatus();
    return reply.send({ ok: true, ...st, owner: cred("OWNER_WHATSAPP") });
  });

  app.post("/painel/api/whatsapp/connect", async (req, reply) => {
    if (!guard(req, reply)) return;
    void startWhatsApp();
    return reply.send({ ok: true });
  });

  app.post("/painel/api/whatsapp/logout", async (req, reply) => {
    if (!guard(req, reply)) return;
    await logoutWhatsApp();
    return reply.send({ ok: true });
  });

  // Quem pode falar com o secretário (allow-list). No modo "você mesmo", é o próprio número.
  app.post("/painel/api/whatsapp/owner", async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { ownerWhatsapp?: string };
    const num = (body.ownerWhatsapp ?? "").trim().replace(/\D/g, "");
    if (!num) return reply.send({ ok: false, error: "Informe o número." });
    await setCredentials({ OWNER_WHATSAPP: num });
    return reply.send({ ok: true });
  });

  log.info("[painel] rotas /painel registradas" + (panelReady() ? "" : " (desativado: defina PANEL_PASSWORD)"));
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const STYLE = `
:root{--bg:#090c13;--card:#111621;--soft:#18202e;--line:#222d40;--fg:#e2e8f5;--mut:#6b7a96;--acc:#4f7eff;--ok:#10b981;--warn:#f59e0b;--err:#ef4444}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;min-height:100vh}
a{color:var(--acc);text-decoration:none}
code{background:var(--soft);padding:1px 6px;border-radius:4px;font-size:13px}

.hdr{display:flex;align-items:center;gap:16px;padding:0 20px;height:54px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:100}
.brand{font-size:15px;font-weight:650;white-space:nowrap;display:flex;align-items:center;gap:7px}
.nav{display:flex;margin:0 auto}
.nav-btn{background:none;border:none;color:var(--mut);font-size:14px;padding:0 16px;height:54px;cursor:pointer;border-bottom:2px solid transparent;font:inherit;font-weight:500;transition:color .15s,border-color .15s}
.nav-btn:hover{color:var(--fg)}
.nav-btn.active{color:var(--fg);border-bottom-color:var(--acc)}
.hdr-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.chips{display:flex;gap:5px}
.chip{font-size:11px;padding:3px 9px;border-radius:999px;background:var(--soft);color:var(--mut);border:1px solid var(--line);display:flex;align-items:center;gap:5px;white-space:nowrap}
.chip::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--mut);flex-shrink:0}
.chip.on{color:var(--ok);border-color:rgba(16,185,129,.2)}
.chip.on::before{background:var(--ok)}

.page{display:none}
.page.active{display:block}
.pg{max-width:1100px;margin:0 auto;padding:28px 20px}
.pg-title{font-size:20px;font-weight:650;margin-bottom:24px}

.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}
.ctitle{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin-bottom:14px;font-weight:600}

.chat-layout{display:grid;grid-template-columns:1fr 280px;gap:20px;height:calc(100vh - 108px);min-height:400px}
@media(max-width:740px){.chat-layout{grid-template-columns:1fr;height:auto}}
.chat-card{background:var(--card);border:1px solid var(--line);border-radius:16px;display:flex;flex-direction:column;overflow:hidden}
.chat-hdr{padding:12px 18px;border-bottom:1px solid var(--line);font-size:11px;color:var(--mut);letter-spacing:.05em;text-transform:uppercase;font-weight:600}
.chat-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:82%;padding:10px 13px;border-radius:13px;white-space:pre-wrap;word-wrap:break-word;font-size:14px;line-height:1.5}
.msg.user{align-self:flex-end;background:var(--acc);color:#fff;border-bottom-right-radius:4px}
.msg.assistant{align-self:flex-start;background:var(--soft);border-bottom-left-radius:4px}
.msg .who{display:block;font-size:10px;opacity:.55;margin-bottom:4px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.chat-compose{padding:12px 14px;border-top:1px solid var(--line);display:flex;gap:8px}
.cinp{flex:1;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--fg);resize:none;font:inherit;transition:border-color .15s}
.cinp:focus{outline:none;border-color:var(--acc)}
.chat-err{padding:3px 14px;color:var(--err);font-size:12px;min-height:20px}

.int-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:16px}
.int-card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:26px;transition:border-color .2s}
.int-card:hover{border-color:#2e3a52}
.int-card.ok-card{border-color:rgba(16,185,129,.35)}
.int-head{display:flex;align-items:center;gap:14px;margin-bottom:14px}
.int-icon{width:50px;height:50px;border-radius:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.int-icon.ggl{background:#fff}
.int-icon.wap{background:#128c7e;font-size:26px}
.int-name{font-size:16px;font-weight:650}
.int-badge{font-size:11px;padding:3px 9px;border-radius:999px;margin-top:4px;display:inline-block;background:var(--soft);border:1px solid var(--line);color:var(--mut)}
.int-badge.ok{background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.3);color:var(--ok)}
.int-badge.rdy{background:rgba(79,126,255,.1);border-color:rgba(79,126,255,.3);color:var(--acc)}
.int-desc{color:var(--mut);font-size:14px;margin-bottom:18px;line-height:1.6}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:10px 18px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;border:none;font:inherit;font-weight:600;transition:opacity .15s,transform .1s}
.btn:active{transform:scale(.98)}
.btn:hover{opacity:.88}
.btn-full{width:100%}
.btn-pri{background:var(--acc);color:#fff}
.btn-ggl{background:#4285f4;color:#fff}
.btn-wap{background:#25d366;color:#0a2010;font-weight:700}
.btn-ghost{background:var(--soft);color:var(--fg);border:1px solid var(--line);font-weight:500}
.btn-danger{background:rgba(239,68,68,.1);color:var(--err);border:1px solid rgba(239,68,68,.2);font-weight:500}
.btn-sm{padding:6px 12px;font-size:13px;border-radius:8px}

.fg{display:flex;flex-direction:column;gap:10px}
.flabel{font-size:12px;color:var(--mut);margin-bottom:4px;display:block;font-weight:500}
.finp{width:100%;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--fg);font:inherit;transition:border-color .15s}
.finp:focus{outline:none;border-color:var(--acc)}

.info-row{display:flex;align-items:center;gap:8px;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:9px 12px;margin:6px 0 14px}
.info-val{font-family:monospace;font-size:12px;flex:1;color:var(--fg);word-break:break-all}
.cpbtn{background:var(--card);border:1px solid var(--line);color:var(--mut);padding:4px 10px;border-radius:7px;font-size:12px;cursor:pointer;white-space:nowrap;font:inherit;transition:color .1s,border-color .1s}
.cpbtn:hover{color:var(--fg);border-color:var(--acc)}

.step{display:flex;gap:12px;margin-bottom:18px}
.step-n{min-width:24px;height:24px;border-radius:50%;background:var(--acc);color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px}
.step-title{font-size:13px;font-weight:650;margin-bottom:4px}
.step-desc{font-size:13px;color:var(--mut);margin-bottom:4px}

.ok-row{display:flex;align-items:center;gap:8px;color:var(--ok);font-size:14px;font-weight:600;margin-bottom:14px}
.ok-dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex-shrink:0}

.err{color:var(--err);font-size:13px;min-height:18px}
.suc{color:var(--ok);font-size:13px}
.muted{color:var(--mut)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.sep{border:none;border-top:1px solid var(--line);margin:14px 0}
.item{padding:10px 0;border-bottom:1px solid var(--line)}
.item:last-child{border-bottom:none}
.itop{display:flex;gap:8px;align-items:baseline;justify-content:space-between}
.tag{font-size:11px;color:var(--mut);background:var(--soft);padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.empty{color:var(--mut);font-style:italic;padding:4px 0}
.stat{display:flex;justify-content:space-between;padding:4px 0;font-size:14px;color:var(--mut)}
.stat b{color:var(--fg)}

.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#10b981;color:#fff;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;box-shadow:0 4px 24px rgba(0,0,0,.4);opacity:0;pointer-events:none;transition:opacity .3s}
.toast.show{opacity:1}
.spin{width:32px;height:32px;border:3px solid var(--line);border-top-color:var(--acc);border-radius:50%;display:inline-block;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.wa-tabs{display:flex;gap:5px;background:var(--soft);border:1px solid var(--line);border-radius:11px;padding:4px;margin-bottom:16px}
.wa-tab{flex:1;background:none;border:none;color:var(--mut);font:inherit;font-weight:600;font-size:13px;padding:8px 6px;border-radius:8px;cursor:pointer;transition:background .15s,color .15s}
.wa-tab:hover{color:var(--fg)}
.wa-tab.active{background:var(--card);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.25)}
.steps-ol{color:var(--mut);font-size:13px;margin:0 0 16px;padding-left:18px;line-height:1.75}
.steps-ol li{margin-bottom:6px}
.steps-ol b{color:var(--fg)}
`;

const GOOGLE_G = `<svg viewBox="0 0 24 24" width="26" height="26"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>`;

const WA_ICON = `<svg viewBox="0 0 24 24" width="28" height="28" fill="#25d366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12.05 2.025C6.495 2.025 1.98 6.535 1.98 12.085c0 1.76.46 3.413 1.26 4.847L1.98 22.025l5.245-1.375a10.04 10.04 0 0 0 4.825 1.23c5.555 0 10.07-4.51 10.07-10.06C22.12 6.27 17.6 2.025 12.05 2.025z"/></svg>`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function loginPage(): string {
  return shell("Secretário — Painel", `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div class="card" style="width:360px">
        <div style="text-align:center;margin-bottom:20px">
          <div style="font-size:40px;margin-bottom:10px">🤖</div>
          <div style="font-size:18px;font-weight:650">Secretário</div>
          <div class="muted" style="font-size:13px;margin-top:4px">Área restrita ao dono</div>
        </div>
        <form id="f" class="fg">
          <div><label class="flabel">Senha do painel</label><input class="finp" id="pw" type="password" autofocus></div>
          <button class="btn btn-pri btn-full">Entrar</button>
          <div class="err" id="err"></div>
        </form>
      </div>
    </div>
    <script>
    document.getElementById('f').addEventListener('submit',function(e){
      e.preventDefault();var err=document.getElementById('err');err.textContent='';
      fetch('/painel/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})})
      .then(function(r){return r.json();}).then(function(j){if(j.ok){location.href='/painel';}else{err.textContent=j.error||'Senha incorreta.';}});
    });
    </script>`);
}

function dashboardPage(): string {
  const owner = config.OWNER_NAME;
  return shell(`Secretário de ${owner}`, `
    <header class="hdr">
      <div class="brand"><span>🤖</span> Secretário de ${owner}</div>
      <nav class="nav" id="nav">
        <button class="nav-btn active" data-page="chat">Chat</button>
        <button class="nav-btn" data-page="integrations">Integrações</button>
        <button class="nav-btn" data-page="settings">Configurações</button>
      </nav>
      <div class="hdr-right">
        <div class="chips" id="chips"></div>
        <button class="btn btn-ghost btn-sm" id="logout">Sair</button>
      </div>
    </header>

    <div id="toast" class="toast"></div>

    <!-- ===== CHAT ===== -->
    <div id="page-chat" class="page active">
      <div class="pg">
        <div class="chat-layout">
          <div class="chat-card">
            <div class="chat-hdr">Conversa — mesmo secretário do WhatsApp</div>
            <div class="chat-log" id="log"></div>
            <div class="chat-err" id="chatErr"></div>
            <div class="chat-compose">
              <textarea class="cinp" id="inp" rows="2" placeholder="Fale com seu secretário... (Enter envia)"></textarea>
              <button class="btn btn-pri" id="send">Enviar</button>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:16px;overflow-y:auto">
            <div class="card">
              <div class="ctitle">Agenda de hoje</div>
              <div id="agenda"></div>
            </div>
            <div class="card">
              <div class="ctitle">Uso — Claude</div>
              <div id="usage"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== INTEGRAÇÕES ===== -->
    <div id="page-integrations" class="page">
      <div class="pg">
        <h2 class="pg-title">Integrações</h2>
        <div class="int-grid">

          <!-- Google -->
          <div class="int-card" id="card-google">
            <div class="int-head">
              <div class="int-icon ggl">${GOOGLE_G}</div>
              <div>
                <div class="int-name">Google Agenda</div>
                <span class="int-badge" id="g-badge">Não configurada</span>
              </div>
            </div>
            <p class="int-desc">Veja seus eventos, crie compromissos e receba o briefing diário com sua agenda direto pelo secretário.</p>

            <!-- Setup form (when no client id) -->
            <div id="g-setup">
              <p class="muted" style="font-size:13px;margin-bottom:14px">Configure uma vez o app OAuth do Google para habilitar o botão de conexão.</p>
              <form id="fGoogle" class="fg">
                <div><label class="flabel">Client ID</label><input class="finp" id="gId" placeholder="...apps.googleusercontent.com"></div>
                <div><label class="flabel">Client Secret</label><input class="finp" type="password" id="gSecret" placeholder="GOCSPX-..."></div>
                <div class="err" id="gErr"></div>
                <button class="btn btn-pri btn-full">Salvar e continuar</button>
              </form>
            </div>

            <!-- Authorize button (configured, not connected) -->
            <div id="g-connect" style="display:none">
              <a href="/oauth/google/start">
                <button class="btn btn-ggl btn-full" type="button">${GOOGLE_G} &nbsp;Conectar com Google</button>
              </a>
              <p class="muted" style="font-size:12px;margin-top:8px;text-align:center">Uma janela do Google abrirá — basta entrar e aceitar.</p>
            </div>

            <!-- Connected state -->
            <div id="g-connected" style="display:none">
              <div class="ok-row"><span class="ok-dot"></span>Agenda conectada e sincronizada</div>
              <button class="btn btn-danger btn-sm" id="gDisconnect">Desconectar agenda</button>
            </div>
          </div>

          <!-- WhatsApp -->
          <div class="int-card" id="card-wa">
            <div class="int-head">
              <div class="int-icon wap">${WA_ICON}</div>
              <div>
                <div class="int-name">WhatsApp</div>
                <span class="int-badge" id="w-badge">Não conectado</span>
              </div>
            </div>

            <!-- escolha do método -->
            <div class="wa-tabs">
              <button class="wa-tab active" type="button" data-wam="qr">Meu número (QR)</button>
              <button class="wa-tab" type="button" data-wam="meta">Número dedicado</button>
            </div>

            <!-- ===================== Método: QR Code ===================== -->
            <div id="wa-method-qr">
              <p class="int-desc">Conecte por QR Code, igual ao WhatsApp Web. Usa o <b>seu próprio número</b> — você fala com o secretário na conversa "você mesmo". Inclui áudio.</p>

              <!-- idle: connect button -->
              <div id="w-idle">
                <button class="btn btn-wap btn-full" id="w-connect" type="button">${WA_ICON} &nbsp;Conectar via QR Code</button>
              </div>

              <!-- connecting -->
              <div id="w-connecting" style="display:none;text-align:center;padding:14px 0">
                <div class="spin"></div>
                <p class="muted" style="margin-top:12px">Gerando QR Code...</p>
              </div>

              <!-- qr -->
              <div id="w-qr" style="display:none">
                <div style="text-align:center"><img id="w-qr-img" alt="QR Code" style="width:240px;height:240px;border-radius:12px;background:#fff;padding:8px"></div>
                <ol class="muted" style="font-size:13px;margin:14px 0 0;padding-left:20px;line-height:1.9">
                  <li>Abra o <b>WhatsApp</b> no celular que será o secretário</li>
                  <li>Toque em <b>Aparelhos conectados</b> › <b>Conectar aparelho</b></li>
                  <li>Aponte a câmera para este código</li>
                </ol>
              </div>

              <!-- open -->
              <div id="w-open" style="display:none">
                <div class="ok-row"><span class="ok-dot"></span><span id="w-me">Conectado</span></div>
                <p class="muted" style="font-size:13px;margin-bottom:10px">✅ Tudo pronto! Fale com o secretário no chat <b>“Conversa com você mesmo”</b> do seu WhatsApp — pode mandar texto ou áudio.</p>
                <label class="flabel">Quem pode falar com o secretário?</label>
                <div class="row" style="margin-bottom:6px">
                  <input class="finp" id="w-owner" placeholder="55 11 99999-8888" style="flex:1">
                  <button class="btn btn-pri btn-sm" id="w-owner-save" type="button">Salvar</button>
                </div>
                <p class="muted" style="font-size:12px;margin-bottom:14px">Já configurado com o seu número automaticamente. Mude aqui só se quiser usar outro número.</p>
                <button class="btn btn-danger btn-sm" id="w-logout" type="button">Desconectar</button>
              </div>
            </div>

            <!-- ===================== Método: Meta Business API ===================== -->
            <div id="wa-method-meta" style="display:none">
              <p class="int-desc">Use um <b>número dedicado</b> ao secretário (a Meta dá um número de teste grátis). Você manda mensagem pra ele como pra qualquer contato.</p>

              <!-- setup -->
              <div id="m-setup">
                <ol class="steps-ol">
                  <li>Crie um app em <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com</a> (tipo <b>Empresa</b>) e adicione o produto <b>WhatsApp</b>.</li>
                  <li>Em <b>WhatsApp › Configuração</b>, na seção de <b>Webhook</b>, clique em "Editar" e cole a URL e o token abaixo. Depois clique em <b>Verificar e salvar</b> e assine o campo <code>messages</code>.</li>
                </ol>

                <label class="flabel">URL de callback (webhook)</label>
                <div class="info-row"><span class="info-val" id="m-webhook"></span><button class="cpbtn" type="button" onclick="copyText('m-webhook',this)">Copiar</button></div>

                <label class="flabel">Token de verificação</label>
                <div class="info-row"><span class="info-val" id="m-verify"></span><button class="cpbtn" type="button" onclick="copyText('m-verify',this)">Copiar</button></div>

                <hr class="sep">
                <ol class="steps-ol" start="3">
                  <li>Em <b>WhatsApp › API Setup</b>, copie o <b>Phone number ID</b> e o <b>token de acesso</b> e cole aqui:</li>
                </ol>

                <form id="fMeta" class="fg">
                  <div><label class="flabel">Phone number ID</label><input class="finp" id="m-pnid" placeholder="ex.: 123456789012345"></div>
                  <div><label class="flabel">Token de acesso</label><input class="finp" type="password" id="m-token" placeholder="EAAG..."></div>
                  <div><label class="flabel">App Secret <span class="muted">(opcional, mais seguro)</span></label><input class="finp" type="password" id="m-secret" placeholder="valida a assinatura dos eventos"></div>
                  <div><label class="flabel">Seu número (quem fala com o secretário)</label><input class="finp" id="m-owner" placeholder="55 11 99999-8888"></div>
                  <div class="err" id="m-err"></div>
                  <button class="btn btn-wap btn-full">Salvar e ativar</button>
                </form>
              </div>

              <!-- configurado -->
              <div id="m-connected" style="display:none">
                <div class="ok-row"><span class="ok-dot"></span><span id="m-me">WhatsApp (Meta) ativo</span></div>
                <p class="muted" style="font-size:13px;margin-bottom:12px">Mande uma mensagem do seu WhatsApp para o número do secretário para testar — texto ou áudio.</p>
                <div class="row">
                  <button class="btn btn-ghost btn-sm" id="m-edit" type="button">Editar credenciais</button>
                  <button class="btn btn-danger btn-sm" id="m-disconnect" type="button">Remover</button>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- ===== CONFIGURAÇÕES ===== -->
    <div id="page-settings" class="page">
      <div class="pg">
        <h2 class="pg-title">Configurações</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div>
            <div class="card">
              <div class="ctitle">Memória do secretário</div>
              <div id="facts"></div>
              <form id="fFact" class="row" style="margin-top:12px">
                <input class="finp" id="fcat" placeholder="categoria" style="flex:0 0 90px">
                <input class="finp" id="fkey" placeholder="chave" style="flex:1">
                <input class="finp" id="fval" placeholder="valor" style="flex:2">
                <button class="btn btn-pri btn-sm">+</button>
              </form>
            </div>
            <div class="card">
              <div class="ctitle">Lembretes</div>
              <div id="reminders"></div>
              <form id="fRem" class="row" style="margin-top:12px">
                <input class="finp" id="rtext" placeholder="o que lembrar" style="flex:2">
                <input class="finp" type="datetime-local" id="rwhen" style="flex:1">
                <button class="btn btn-pri btn-sm">+</button>
              </form>
            </div>
          </div>
          <div>
            <div class="card">
              <div class="ctitle">Agenda de hoje</div>
              <div id="sagenda"></div>
            </div>
            <div class="card">
              <div class="ctitle">Uso — Claude</div>
              <div id="susage"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script>${DASH_JS}</script>`);
}

const DASH_JS = [
  "var S=null,curPage='chat';",
  "function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e;}",
  "function api(p,b){return fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json();});}",
  "function toast(msg,ok){var t=document.getElementById('toast');t.textContent=msg;t.style.background=ok===false?'var(--err)':'var(--ok)';t.className='toast show';setTimeout(function(){t.className='toast';},3000);}",
  "function copyText(id,btn){var el2=document.getElementById(id);if(!el2)return;var txt=el2.textContent||'';navigator.clipboard.writeText(txt).catch(function(){var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();});if(btn){btn.textContent='✓ Copiado!';setTimeout(function(){btn.textContent='Copiar';},2000);}}",

  // Navigation
  "function showPage(name){",
  "['chat','integrations','settings'].forEach(function(p){var pg=document.getElementById('page-'+p);if(pg)pg.style.display=p===name?'block':'none';});",
  "document.querySelectorAll('.nav-btn').forEach(function(b){b.classList.toggle('active',b.getAttribute('data-page')===name);});",
  "curPage=name;",
  "if(name==='integrations')renderIntegrations();",
  "if(name==='settings'){renderFacts();renderReminders();renderSAgenda();renderSUsage();}",
  "}",

  // Load & render
  "function load(){return fetch('/painel/api/state').then(function(r){return r.json();}).then(function(s){if(!s.ok)return;S=s;render();});}",
  "function render(){renderChips();renderLog();renderAgenda();renderUsage();if(curPage==='integrations')renderIntegrations();if(curPage==='settings'){renderFacts();renderReminders();renderSAgenda();renderSUsage();}}",

  // Chips
  "function renderChips(){var c=document.getElementById('chips');if(!c||!S)return;c.innerHTML='';var r=S.readiness;[['Claude',r.claude],['WhatsApp',r.whatsapp],['Agenda',r.calendarConnected]].forEach(function(d){c.appendChild(el('span','chip'+(d[1]?' on':''),d[0]));});}",

  // Chat
  "function renderLog(){var l=document.getElementById('log');if(!l||!S)return;l.innerHTML='';(S.messages||[]).forEach(function(m){addMsg(m.role,m.content,false);});scrollLog();}",
  "function addMsg(role,text,scroll){var l=document.getElementById('log');if(!l)return;var m=el('div','msg '+(role==='user'?'user':'assistant'));var w=el('span','who',role==='user'?(S&&S.owner||'você'):'secretário');m.appendChild(w);m.appendChild(document.createTextNode(text));l.appendChild(m);if(scroll!==false)scrollLog();}",
  "function addImgMsg(url,cap){var l=document.getElementById('log');if(!l)return;var m=el('div','msg assistant');m.appendChild(el('span','who','secretário'));var img=document.createElement('img');img.src=url;img.alt='imagem';img.style.cssText='max-width:100%;border-radius:8px;margin-top:6px;display:block';m.appendChild(img);if(cap)m.appendChild(el('div','muted',cap));l.appendChild(m);scrollLog();}",
  "function scrollLog(){var l=document.getElementById('log');if(l)l.scrollTop=l.scrollHeight;}",
  "function sendMsg(){var i=document.getElementById('inp');var t=(i.value||'').trim();if(!t)return;var err=document.getElementById('chatErr');if(err)err.textContent='';i.value='';addMsg('user',t);var b=document.getElementById('send');b.disabled=true;b.textContent='...';var tp=el('div','msg assistant','escrevendo...');tp.id='typing';document.getElementById('log').appendChild(tp);scrollLog();api('/painel/api/chat',{text:t}).then(function(j){var tp2=document.getElementById('typing');if(tp2)tp2.remove();b.disabled=false;b.textContent='Enviar';if(j.ok){addMsg('assistant',j.reply);if(j.imageUrl)addImgMsg(j.imageUrl,j.imageCaption||'');load();}else if(err)err.textContent=j.error||'Falha.';}).catch(function(){var tp2=document.getElementById('typing');if(tp2)tp2.remove();b.disabled=false;b.textContent='Enviar';if(err)err.textContent='Erro de rede.';});}",

  // Agenda + Usage (chat sidebar)
  "function renderAgenda(){var box=document.getElementById('agenda');if(!box||!S)return;box.innerHTML='';if(!S.readiness.calendarConnected){box.appendChild(el('div','empty','Conecte em Integrações'));return;}var a=S.agenda||[];if(!a.length){box.appendChild(el('div','empty','Sem eventos hoje'));return;}a.forEach(function(e){var it=el('div','item');it.appendChild(el('div',null,e.summary));it.appendChild(el('div','muted',e.start+(e.location?' · '+e.location:'')));box.appendChild(it);});}",
  "function renderUsage(){var box=document.getElementById('usage');if(!box||!S)return;box.innerHTML='';var u=S.usage||{};function row(k,v){var r=el('div','stat');r.appendChild(el('span',null,k));r.appendChild(el('b',null,(v||0).toLocaleString('pt-BR')));box.appendChild(r);}row('Chamadas',u.calls);row('Tokens entrada',u.inputTokens);row('Tokens saída',u.outputTokens);}",

  // Integrations
  "function renderIntegrations(){if(!S)return;var ig=S.integrations||{};var g=ig.google||{};var w=ig.whatsapp||{};",

  // Google states
  "var gCard=document.getElementById('card-google');var gBadge=document.getElementById('g-badge');var gSetup=document.getElementById('g-setup');var gConn=document.getElementById('g-connect');var gOk=document.getElementById('g-connected');",
  "if(gBadge){if(g.connected){if(gCard)gCard.className='int-card ok-card';gBadge.className='int-badge ok';gBadge.textContent='Conectada ✓';if(gSetup)gSetup.style.display='none';if(gConn)gConn.style.display='none';if(gOk)gOk.style.display='';}else if(g.configured){if(gCard)gCard.className='int-card';gBadge.className='int-badge rdy';gBadge.textContent='Pronta — clique para autorizar';if(gSetup)gSetup.style.display='none';if(gConn)gConn.style.display='';if(gOk)gOk.style.display='none';}else{if(gCard)gCard.className='int-card';gBadge.className='int-badge';gBadge.textContent='Não configurada';if(gSetup)gSetup.style.display='';if(gConn)gConn.style.display='none';if(gOk)gOk.style.display='none';}}",
  "var gIdEl=document.getElementById('gId');if(gIdEl&&g.clientId&&!gIdEl.value)gIdEl.value=g.clientId;",

  // WhatsApp: popula campos do método Meta e decide o método inicial.
  "var mHook=document.getElementById('m-webhook');if(mHook)mHook.textContent=w.webhookUrl||'(defina a PUBLIC_URL do serviço primeiro)';",
  "var mVer=document.getElementById('m-verify');if(mVer)mVer.textContent=w.verifyToken||'(gerando...)';",
  "var mPn=document.getElementById('m-pnid');if(mPn&&w.phoneNumberId&&!mPn.value)mPn.value=w.phoneNumberId;",
  "var mOw=document.getElementById('m-owner');if(mOw&&w.ownerWhatsapp&&!mOw.value)mOw.value=w.ownerWhatsapp;",
  "if(!waMethodInit){var saved=null;try{saved=localStorage.getItem('waMethod');}catch(e){}showWaMethod(saved||(w.configured?'meta':'qr'));waMethodInit=true;}",
  "applyMetaState(w);",
  "if(waMethod==='qr'){pollWa();startWaPoll();}",
  "}",

  // Alterna entre os métodos QR e Meta dentro do card do WhatsApp.
  "var waMethod='qr',waMethodInit=false;",
  "function showWaMethod(m){waMethod=m;try{localStorage.setItem('waMethod',m);}catch(e){}",
  "var q=document.getElementById('wa-method-qr'),mt=document.getElementById('wa-method-meta');",
  "if(q)q.style.display=m==='qr'?'block':'none';if(mt)mt.style.display=m==='meta'?'block':'none';",
  "document.querySelectorAll('.wa-tab').forEach(function(b){b.classList.toggle('active',b.getAttribute('data-wam')===m);});",
  "if(m==='qr'){pollWa();startWaPoll();}else{stopWaPoll();if(S&&S.integrations&&S.integrations.whatsapp)applyMetaState(S.integrations.whatsapp);}}",

  // Estado do método Meta (setup x configurado) + badge quando este método está ativo.
  "function applyMetaState(w){var setup=document.getElementById('m-setup'),conn=document.getElementById('m-connected');if(!setup||!conn)return;",
  "if(w.configured){setup.style.display='none';conn.style.display='block';}else{setup.style.display='block';conn.style.display='none';}",
  "if(waMethod==='meta'){var card=document.getElementById('card-wa'),badge=document.getElementById('w-badge');",
  "if(w.configured){card.className='int-card ok-card';badge.className='int-badge ok';badge.textContent='Conectado ✓';}",
  "else{card.className='int-card';badge.className='int-badge';badge.textContent='Não conectado';}}}",

  // ---- WhatsApp QR (poller próprio) ----
  "var waTimer=null;",
  "function startWaPoll(){if(waTimer)return;waTimer=setInterval(function(){if(curPage!=='integrations'){stopWaPoll();return;}pollWa();},2500);}",
  "function stopWaPoll(){if(waTimer){clearInterval(waTimer);waTimer=null;}}",
  "function pollWa(){return fetch('/painel/api/whatsapp/status').then(function(r){return r.json();}).then(function(st){if(st&&st.ok)applyWa(st);return st;}).catch(function(){});}",
  "function applyWa(st){var idle=document.getElementById('w-idle'),conn=document.getElementById('w-connecting'),qr=document.getElementById('w-qr'),open=document.getElementById('w-open'),badge=document.getElementById('w-badge'),card=document.getElementById('card-wa');if(!badge)return;idle.style.display='none';conn.style.display='none';qr.style.display='none';open.style.display='none';var s=st.state||'idle';",
  "if(s==='open'){card.className='int-card ok-card';badge.className='int-badge ok';badge.textContent='Conectado ✓';open.style.display='block';document.getElementById('w-me').textContent=st.me?('Conectado como +'+st.me):'Conectado';var ow=document.getElementById('w-owner');if(ow&&!ow.value)ow.value=st.owner||st.me||'';stopWaPoll();}",
  "else if(s==='qr'){card.className='int-card';badge.className='int-badge rdy';badge.textContent='Escaneie o QR';qr.style.display='block';if(st.qr)document.getElementById('w-qr-img').src=st.qr;}",
  "else if(s==='connecting'){card.className='int-card';badge.className='int-badge rdy';badge.textContent='Conectando...';conn.style.display='block';}",
  "else{card.className='int-card';badge.className='int-badge';badge.textContent='Não conectado';idle.style.display='block';}}",

  // Settings
  "function renderFacts(){var box=document.getElementById('facts');if(!box||!S)return;box.innerHTML='';var f=S.facts||[];if(!f.length){box.appendChild(el('div','empty','(nada memorizado ainda)'));return;}f.forEach(function(x){var it=el('div','item');var top=el('div','itop');var left=el('div');left.appendChild(el('span','tag',x.category));left.appendChild(document.createTextNode(' '+x.key));var b=el('button','btn btn-danger btn-sm','esquecer');b.onclick=function(){api('/painel/api/memory/forget',{key:x.key}).then(load);};top.appendChild(left);top.appendChild(b);it.appendChild(top);it.appendChild(el('div','muted',x.value));box.appendChild(it);});}",
  "function renderReminders(){var box=document.getElementById('reminders');if(!box||!S)return;box.innerHTML='';var r=S.reminders||[];if(!r.length){box.appendChild(el('div','empty','(nenhum em aberto)'));return;}r.forEach(function(x){var it=el('div','item');var top=el('div','itop');top.appendChild(el('div',null,x.text));top.appendChild(el('span','tag',x.due));it.appendChild(top);var act=el('div','row');var d=el('button','btn btn-ghost btn-sm','✓ feito');d.onclick=function(){api('/painel/api/reminders/done',{id:x.id}).then(load);};var c=el('button','btn btn-ghost btn-sm','cancelar');c.onclick=function(){api('/painel/api/reminders/cancel',{id:x.id}).then(load);};act.appendChild(d);act.appendChild(c);it.appendChild(act);box.appendChild(it);});}",
  "function renderSAgenda(){var box=document.getElementById('sagenda');if(!box||!S)return;box.innerHTML='';if(!S.readiness.calendarConnected){box.appendChild(el('div','empty','Agenda não conectada'));return;}var a=S.agenda||[];if(!a.length){box.appendChild(el('div','empty','(sem eventos hoje)'));return;}a.forEach(function(e){var it=el('div','item');it.appendChild(el('div',null,e.summary));it.appendChild(el('div','muted',e.start+(e.location?' · '+e.location:'')));box.appendChild(it);});}",
  "function renderSUsage(){var box=document.getElementById('susage');if(!box||!S)return;box.innerHTML='';var u=S.usage||{};function row2(k,v){var r=el('div','stat');r.appendChild(el('span',null,k));r.appendChild(el('b',null,(v||0).toLocaleString('pt-BR')));box.appendChild(r);}row2('Chamadas',u.calls);row2('Tokens entrada',u.inputTokens);row2('Tokens saída',u.outputTokens);row2('Cache leitura',u.cacheReadTokens);}",

  // Wiring — navigation
  "document.querySelectorAll('.nav-btn').forEach(function(b){b.addEventListener('click',function(){showPage(b.getAttribute('data-page'));load();});});",
  "document.getElementById('logout').addEventListener('click',function(){api('/painel/logout',{}).then(function(){location.href='/painel';});});",

  // Wiring — chat
  "document.getElementById('send').addEventListener('click',sendMsg);",
  "document.getElementById('inp').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});",

  // Wiring — WhatsApp QR
  "document.getElementById('w-connect').addEventListener('click',function(){applyWa({state:'connecting'});api('/painel/api/whatsapp/connect',{}).then(function(){startWaPoll();setTimeout(pollWa,800);});});",
  "document.getElementById('w-logout').addEventListener('click',function(){if(!confirm('Desconectar o WhatsApp? Você precisará escanear o QR de novo.'))return;api('/painel/api/whatsapp/logout',{}).then(function(){toast('WhatsApp desconectado');applyWa({state:'idle'});});});",
  "document.getElementById('w-owner-save').addEventListener('click',function(){var num=document.getElementById('w-owner').value.trim();if(!num){toast('Informe o número',false);return;}api('/painel/api/whatsapp/owner',{ownerWhatsapp:num}).then(function(j){if(j.ok){toast('Número salvo!');load();}else{toast(j.error||'Falha',false);}});});",

  // Wiring — alternância de método + Meta API
  "document.querySelectorAll('.wa-tab').forEach(function(b){b.addEventListener('click',function(){showWaMethod(b.getAttribute('data-wam'));});});",
  "document.getElementById('fMeta').addEventListener('submit',function(e){e.preventDefault();var err=document.getElementById('m-err');err.className='err';err.textContent='';var pn=document.getElementById('m-pnid').value.trim();var tk=document.getElementById('m-token').value.trim();var sc=document.getElementById('m-secret').value.trim();var ow=document.getElementById('m-owner').value.trim();if(!pn||!tk){err.textContent='Preencha o Phone number ID e o token de acesso.';return;}api('/painel/api/integrations/whatsapp',{phoneNumberId:pn,accessToken:tk,appSecret:sc,ownerWhatsapp:ow}).then(function(j){if(j.ok){toast('WhatsApp (Meta) ativado!');document.getElementById('m-token').value='';document.getElementById('m-secret').value='';load();}else{err.textContent=j.error||'Falha ao salvar.';}});});",
  "document.getElementById('m-edit').addEventListener('click',function(){document.getElementById('m-connected').style.display='none';document.getElementById('m-setup').style.display='block';});",
  "document.getElementById('m-disconnect').addEventListener('click',function(){if(!confirm('Remover a configuração da Meta? O secretário deixa de responder por este número.'))return;api('/painel/api/integrations/whatsapp/disconnect',{}).then(function(){toast('Configuração removida');load();});});",

  // Wiring — Google disconnect
  "document.getElementById('gDisconnect').addEventListener('click',function(){if(!confirm('Desconectar a Agenda do Google?'))return;api('/painel/api/integrations/google/disconnect',{}).then(function(){toast('Agenda desconectada');load();});});",

  // Wiring — Google form
  "document.getElementById('fGoogle').addEventListener('submit',function(e){e.preventDefault();var err=document.getElementById('gErr');err.textContent='';err.className='err';var id=document.getElementById('gId').value.trim();var sec=document.getElementById('gSecret').value.trim();if(!id||!sec){err.textContent='Preencha Client ID e Secret.';return;}api('/painel/api/integrations/google',{clientId:id,clientSecret:sec}).then(function(j){if(j.ok){err.className='suc';err.textContent='Salvo! Agora clique em Conectar com Google.';document.getElementById('gSecret').value='';load();}else{err.textContent=j.error||'Falha.';}});});",

  // Wiring — Memory form
  "document.getElementById('fFact').addEventListener('submit',function(e){e.preventDefault();var k=document.getElementById('fkey').value.trim();var v=document.getElementById('fval').value.trim();if(!k||!v)return;api('/painel/api/memory',{category:document.getElementById('fcat').value.trim()||'geral',key:k,value:v}).then(function(){document.getElementById('fcat').value='';document.getElementById('fkey').value='';document.getElementById('fval').value='';load();});});",

  // Wiring — Reminders form
  "document.getElementById('fRem').addEventListener('submit',function(e){e.preventDefault();var t=document.getElementById('rtext').value.trim();var w=document.getElementById('rwhen').value;if(!t||!w)return;api('/painel/api/reminders',{text:t,due_at:new Date(w).toISOString()}).then(function(){document.getElementById('rtext').value='';document.getElementById('rwhen').value='';load();});});",

  // Handle OAuth redirect back (?p=integrations&ok=google)
  "var params=new URLSearchParams(location.search);",
  "if(params.get('p')){showPage(params.get('p'));history.replaceState({},'','/painel');}",
  "if(params.get('ok')==='google'){setTimeout(function(){toast('Google Agenda conectada com sucesso!');},500);}",

  // Init
  "load();setInterval(load,30000);",
].join("\n");
