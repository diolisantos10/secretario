# Secretário pessoal no WhatsApp 🤵

Um secretário particular que vive no seu WhatsApp, movido a **Claude (`claude-opus-4-8`)**.
Serviço **standalone** — banco, deploy e código próprios, totalmente isolado do CRM do restaurante.

**O que ele faz (v1):**
- 🧠 **Memória de longo prazo** — lembra de pessoas, preferências, projetos e decisões suas entre conversas.
- ⏰ **Lembretes e tarefas** — "me lembra de ligar pro contador às 15h" → ele te cobra na hora.
- 📅 **Agenda** — lê e cria eventos no seu Google Calendar; entra no resumo do dia.
- 🔎 **Busca na web** — responde com informação atual quando precisa (sem inventar).
- ☀️ **Briefing matinal** — todo dia de manhã, um bom-dia com a agenda e as pendências.

Ele só atende **você** (allow-list pelo seu número). Mensagens de qualquer outro número são ignoradas.

---

## Como está construído

Node + TypeScript (rodado via `tsx`, sem build) · **Fastify** (webhook) · **Prisma + PostgreSQL** (banco próprio) ·
**@anthropic-ai/sdk** · **googleapis** (Calendar) · **node-cron** (proatividade).

```
secretario/
  prisma/schema.prisma      Modelos: Message, MemoryFact, Reminder, GoogleToken, Setting, AiLog
  src/
    index.ts                Boot: sobe Fastify + agendador
    config.ts               Variáveis de ambiente (validadas com zod)
    pipeline.ts             Recebe → dedupe/allow-list → debounce → responde → envia
    server/                 webhook (Meta) · oauth (Google) · assinatura · app
    whatsapp/meta.ts        Enviar/receber pela Graph API
    brain/                  secretary (laço do Claude) · prompt (persona) · tools (ferramentas)
    services/               conversation · memory · reminders · calendar · googleAuth
    scheduler/cron.ts       Lembretes no horário + briefing diário
    util/                   crypto (cifra tokens) · datetime (fuso) · phone (allow-list)
```

**Fluxo de uma mensagem:** webhook valida a assinatura `X-Hub-Signature-256` → responde 200 na hora →
processa em segundo plano: carrega histórico + memória + agenda do dia, chama o Claude (thinking adaptativo,
`effort` configurável, prompt caching no system, busca na web + ferramentas), executa as ferramentas que ele
pedir, e devolve a resposta pelo WhatsApp.

---

## ✅ O que já está pronto / ⏳ a sua parte

**Pronto (todo o código):** webhook, envio, cérebro com as 4 capacidades, memória, lembretes, agenda,
briefing, agendador, deploy. Tudo funciona com placeholders e sobe sem credenciais.

**Sua parte (só credenciais, no final):**
1. Criar/escolher o número na Meta e pegar as chaves.
2. Cadastrar as variáveis de ambiente (abaixo).
3. Apontar o webhook da Meta para o serviço.
4. (Opcional) Conectar o Google Calendar com um clique.

---

## Passo a passo da sua parte

### 1. Subir o serviço no Railway
1. Crie um projeto no [Railway](https://railway.app), conectado a este repositório.
2. Em **Settings → Root Directory** do serviço, aponte para `secretario`.
3. Adicione o plugin **PostgreSQL**. Em **Variables**, crie `DATABASE_URL = ${{Postgres.DATABASE_URL}}`.
4. Faça o deploy. O serviço sobe e o log mostra a "prontidão" (o que falta). O banco é criado sozinho (`prisma db push`).
5. Copie a URL pública do serviço (ex.: `https://secretario-production.up.railway.app`) e cadastre em `PUBLIC_URL`.

### 2. Claude (Anthropic)
- Pegue uma API key em [console da Anthropic](https://console.anthropic.com) → `ANTHROPIC_API_KEY`.

### 3. WhatsApp (Meta Cloud API)
No [developers.facebook.com](https://developers.facebook.com), no seu app (pode ser o mesmo do FOOCCI) → **WhatsApp**:
- **Número:** use o número de teste ou registre um número dedicado para o secretário.
- `META_PHONE_NUMBER_ID` — em *API Setup*.
- `META_ACCESS_TOKEN` — gere um **token permanente** (System User em *Business Settings*), não o temporário de 24h.
- `META_APP_SECRET` — em *Configurações → Básico → Chave Secreta do App*.
- `META_VERIFY_TOKEN` — **uma senha que você inventa** (qualquer texto); vamos repeti-la no passo 4.
- Defina também `OWNER_WHATSAPP` (seu número, só dígitos) e `OWNER_NAME`.

### 4. Apontar o webhook
Em **WhatsApp → Configuration → Webhook**:
- **Callback URL:** `{PUBLIC_URL}/webhook/meta`
- **Verify token:** o mesmo valor de `META_VERIFY_TOKEN`.
- Clique em verificar (o serviço responde ao handshake) e **assine o campo `messages`**.
- Mande uma mensagem do seu número para o número do secretário. Ele deve responder. 🎉

### 5. (Opcional) Conectar o Google Calendar
1. No [Google Cloud Console](https://console.cloud.google.com): crie credenciais **OAuth 2.0 (Web)**, ative a **Calendar API**.
2. Em *Authorized redirect URIs*, adicione exatamente `{PUBLIC_URL}/oauth/google/callback`.
3. Preencha `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` e gere uma `ENCRYPTION_KEY`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. Abra `{PUBLIC_URL}/oauth/google/start` no navegador, autorize, pronto. (Ou peça ao secretário "conecta minha agenda" — ele manda o link.)

---

## Rodar localmente
```bash
cd secretario
cp .env.example .env      # preencha ao menos DATABASE_URL
npm install
npm run db:push           # cria as tabelas
npm run dev               # sobe em http://localhost:8080
```
Para testar o webhook local, exponha a porta com algo como `ngrok http 8080` e use a URL no painel da Meta.

---

## Observações
- **Custo:** o Claude é cobrado por uso (a tabela `AiLog` registra tokens de cada chamada para você acompanhar).
- **Tipos do SDK:** rodamos via `tsx` (sem checagem de tipo em runtime), então o serviço usa a API mais nova do
  Claude mesmo que os *typings* instalados estejam um pouco atrás. `npm install` puxa o SDK mais recente.
- **Privacidade:** tokens do Google ficam **cifrados** (AES-256-GCM) no banco; a assinatura da Meta é verificada
  em todo POST; só o seu número é atendido.
- **Mídia:** a v1 responde a **texto**. Áudio/imagem ficam para uma próxima fase.
