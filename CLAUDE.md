# Secretário — Projeto setup do Claude Code

Configuração automática do Claude Code para este projeto.

## Departamento de Design

Todo trabalho de interface **deve seguir** `DESIGN.md`. Este arquivo define:
- Paleta de cores (tema escuro azul)
- Tipografia (system-ui, sem web fonts)
- Componentes padrão (buttons, cards, inputs, forms)
- Espaçamentos e layout (grid, gaps, padding)
- Animações e transições
- Inconsistências documentadas para corrigir

**Workflow de design**:
1. Use Playwright MCP (`/mcp`) para tirar screenshots do localhost
2. Compare com o padrão no `DESIGN.md`
3. Proponha mudanças (melhoria estética, corrigir inconsistências)
4. Implementa após aprovação
5. Valida com novo screenshot

## Tecnologia

- **Backend**: Node.js (Fastify) + Prisma ORM
- **Frontend**: HTML + CSS inline (sem frameworks) + JavaScript vanilla
- **Design system**: Custom CSS variables (`--bg`, `--card`, `--acc`, etc)
- **Ícones**: Emojis + SVG inline (apenas quando necessário)

## Estrutura relevante

- `src/server/panel.ts` — Painel web (HTML + CSS + JS)
- `DESIGN.md` — Design system (lê automáticamente)
- `.env.example` — Variáveis de ambiente obrigatórias

---

*Última atualização: 2026-07-21*
