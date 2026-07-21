# Design System — Secretário

Documento que descreve o padrão visual e de componentes do painel do Secretário. Gerado a partir da análise do código em `src/server/panel.ts`.

## Paleta de cores

Tema escuro com acentos azuis. Definida em `:root` CSS:

```css
--bg:       #090c13  /* Fundo principal — azul bem escuro */
--card:     #111621  /* Fundo dos cards — azul escuro */
--soft:     #18202e  /* Fundo suave (inputs, backgrounds terciários) */
--line:     #222d40  /* Bordas e divisores */
--fg:       #e2e8f5  /* Texto principal — cinza muito claro */
--mut:      #6b7a96  /* Texto muted/secundário */
--acc:      #4f7eff  /* Azul de destaque — usado em botões, bordas ativas */
--ok:       #10b981  /* Verde — status OK, sucesso */
--warn:     #f59e0b  /* Âmbar — avisos */
--err:      #ef4444  /* Vermelho — erros */
```

### Contraste e acessibilidade
- Texto principal (`--fg`) sobre fundos escuros: **16:1** (WCAG AAA)
- Texto muted (`--mut`) sobre `--soft`: **8:1** (WCAG AA)
- Botões primários (`--acc`): contraste adequado com texto branco

## Tipografia

```css
body {
  font: 15px/1.5 system-ui, -apple-system, sans-serif;
}
```

- **Font stack**: system-ui (padrão do S.O.), fallback -apple-system
- **Tamanho base**: 15px
- **Line height**: 1.5
- **Sem web fonts externas** (melhor performance)

### Pesos de fonte usados
- Regular (400): texto corpo
- Medium (500): labels, subtítulos
- Semi-bold (550–600): títulos, botões
- Bold (650–700): títulos maiores

## Componentes principais

### Header (sticky)
```css
.hdr {
  height: 54px;
  border-bottom: 1px solid var(--line);
  background: var(--card);
  position: sticky;
  top: 0;
  z-index: 100;
}
```
- Altura fixa de 54px
- Barra de marca (`--brand`) + navegação + chips de status + botão logout
- Navegação: abas clicáveis com underline azul (`--acc`) na aba ativa

### Cards
```css
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 20px;
}
```
- Bordas suaves (16px border-radius)
- Espaçamento interno: 20px
- Título da seção (`.ctitle`): 11px, uppercase, letra-spacing 0.06em, cor muted

### Chat
```css
.chat-layout {
  display: grid;
  grid-template-columns: 1fr 280px;  /* 1fr chat + 280px sidebar */
  height: calc(100vh - 108px);
  gap: 20px;
}
```
- **Layout responsivo**: 2 colunas desktop, 1 coluna em dispositivos <740px
- **Mensagens do usuário**: azul (`--acc`), alinhadas à direita, border-radius 13px (arredondado) com canto inferior direito reto
- **Mensagens do asistente**: cinza (`--soft`), alinhadas à esquerda, canto inferior esquerdo reto
- **Who label**: 10px, uppercase, semitransparente

### Botões
Classe-base `.btn` com variantes:

| Variante | Background | Cor texto | Uso |
|----------|-----------|-----------|-----|
| `.btn-pri` | `--acc` (azul) | #fff | Ações primárias |
| `.btn-ggl` | #4285f4 | #fff | Google OAuth |
| `.btn-wap` | #25d366 (verde WhatsApp) | #0a2010 | WhatsApp |
| `.btn-ghost` | `--soft` | `--fg` | Ações secundárias |
| `.btn-danger` | rgba(239,68,68,.1) | `--err` | Destruir/Desconectar |
| `.btn-sm` | — | — | Tamanho pequeno (6px pad, 13px font) |

- Todos têm `border-radius: 10px` (ou 8px se `.btn-sm`)
- Transição hover: `opacity .15s`
- Active (clique): `transform scale(.98)`
- Ícones embarcados (espaço entre ícone e texto: 7px)

### Inputs e formulários
```css
.finp {
  width: 100%;
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 9px 12px;
  color: var(--fg);
}
.finp:focus {
  outline: none;
  border-color: var(--acc);  /* Azul ao focar */
}
```
- Fundo `--soft`, borda `--line`
- Focus: borda muda pra `--acc` (azul)
- Label (`.flabel`): 12px, cor muted, margin-bottom 4px

### Listas
- Grid responsivo: `repeat(auto-fill, minmax(280px, 1fr))`
- Cards com títulos, contadores, checkboxes
- Itens marcados: strikethrough + cor muted

### Painéis dinâmicos (dashboards)
Blocos renderizados genericamente:

| Tipo | Estrutura |
|------|-----------|
| `heading` | Título grande |
| `text` | Parágrafo de texto |
| `kpis` | Grid de KPIs (label + value + hint) |
| `table` | Tabela com `<thead>` e `<tbody>` |
| `checklist` | Lista de checkboxes (apenas leitura) |
| `bars` | Gráfico de barras horizontal |
| `timeline` | Timeline vertical com dots + texto |

## Componentes de integração

Cards de serviço (Telegram, Google, WhatsApp):

```css
.int-card {
  border-radius: 20px;  /* Mais arredondado */
  padding: 26px;
  transition: border-color .2s;
}
.int-card.ok-card {
  border-color: rgba(16, 185, 129, 0.35);  /* Verde sutil */
}
```

**Badges de status**:
- `.int-badge` (padrão): `--soft`, cor muted
- `.int-badge.ok`: verde (`--ok`), fundo com alpha 0.1
- `.int-badge.rdy`: azul (`--acc`), fundo com alpha 0.1

**Ícones**: 50x50px, border-radius 14px, cores:
- Google: fundo branco
- WhatsApp: #128c7e (verde)
- Telegram: #229ED9 (azul)

## Animações e transições

- **Default transition**: `.15s` para cor, opacidade, border
- **Spin (loading)**: `1s linear infinite` (rotate 360deg)
- **Toast notification**: opacity `.3s` (bottom 24px, fixed)
- **Button click**: `scale(.98)` em `.1s` (feedback tátil)

## Espaçamentos padrão (em pixels)

| Nível | Valor | Uso |
|-------|-------|-----|
| xs | 4px | Gaps internos mínimos |
| sm | 8px | Gaps entre elementos |
| md | 14px | Gaps padrão |
| lg | 20px | Padding em cards, container margins |
| xl | 28px | Page padding, grandes margens |

## Inconsistências encontradas

### 1. **Inconsistência de border-radius nos cards**
   - `.int-card` usa 20px
   - Outros `.card` usam 16px
   - **Solução proposta**: Padronizar todos em 16px (mais moderno, menos excessivo)

### 2. **Inconsistência em label styling**
   - Labels em `.flabel` (12px, muted, margin-bottom 4px)
   - Alguns labels inline com `<span>` em capitalization variável
   - **Solução proposta**: Criar classe `.label-alt` para labels inline e padronizar capitalization

### 3. **Inconsistência em gaps de layout**
   - Some layouts usam `gap: 8px`
   - Outros usam `gap: 14px` ou `gap: 20px`
   - Falta sistema formal de spacing
   - **Solução proposta**: Definir classes de utility `.gap-{xs,sm,md,lg}` ou usar CSS custom properties `--gap-*`

### 4. **Tamanhos de fonte variáveis**
   - Titles: 11px (labels), 13px (subtítulos), 15px (padrão), 16px (card titles), 20px (page titles)
   - **Solução proposta**: Criar escala tipográfica formal (xs, sm, base, lg, xl, 2xl)

### 5. **Button sizing sem classes dedic adas**
   - `.btn-sm` existe, mas não há `.btn-md` ou `.btn-lg`
   - Variações inline de padding em alguns botões
   - **Solução proposta**: Criar escala: `.btn-xs` (4px pad), `.btn-sm` (6px), `.btn` (10px), `.btn-lg` (14px)

### 6. **Cor de hover em botões não é uniforme**
   - Alguns botões usam `opacity: .88` hover
   - Alguns usam `color` ou `border-color` diferente
   - **Solução proposta**: Padronizar: botões normais → opacity hover; variantes (ghost, danger) → cor + opacidade

### 7. **Responsive breakpoint único (740px)**
   - Só existe uma media query para `.chat-layout`
   - Sem breakpoints para card grids, sidebars em tablets
   - **Solução proposta**: Adicionar breakpoints padrão (640px mobile, 1024px tablet, 1280px desktop)

## Como usar este documento

Quando trabalhar em novas telas ou componentes:

1. **Defina o tipo**: É um card, um formulário, um modal, um gráfico?
2. **Escolha cores**: Use apenas `--bg`, `--card`, `--soft`, `--line` para fundos; `--fg`, `--mut` para texto; `--acc` para destaque
3. **Aplicar spacing**: Use múltiplos de 8px para gaps/padding (4, 8, 14, 20, 28)
4. **Tipografia**: Base 15px, weights 400/500/600/650, sem web fonts
5. **Componentes**: Reutilize `.btn`, `.card`, `.finp`, `.ctitle`; não crie estilos novos sem documentar aqui

---

**Última atualização**: 2026-07-21  
**Gerado a partir de**: `src/server/panel.ts` (1378 linhas)
