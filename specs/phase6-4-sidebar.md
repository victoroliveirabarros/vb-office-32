# Fase 6.4 — HUD com sidebar recolhível

Base: fases 4–6 (chat, zonas, tema CondoConta, avatares, zoom/visão geral). Mesmos padrões: TS strict sem `any`, comentários mínimos, CSP restritiva (sem inline), acessibilidade, tema claro/escuro.

## Decisões do usuário

- **Sidebar à esquerda**, expandida (~240 px: ícone + rótulo) ou **recolhida em trilho de ícones** (~64 px, tooltip/`aria-label`). Estado lembrado no navegador. No celular vira **gaveta** sobre o mapa (botão de menu), fechada por padrão.
- Itens: **Chat**, **Pessoas**, **Salas**, **Avatar** (Personalizar + mini-perfil), **Configurações**. Topo com marca do produto (nome "vb-office-32"/"Office" — sem logo da empresa) e mini-perfil (seu avatar + nome + sala atual).
- **Mídia (mic/câmera/tela) e zoom continuam flutuando no mapa** (barra de mídia embaixo, zoom no canto); sidebar só para navegação e painéis.

## Escopo

### A. Estrutura

- Layout: sidebar (trilho/expandida) + **painel** que abre ao lado dela para o item ativo (Chat, Pessoas, Salas, Configurações) + mapa ocupando o resto. Um painel por vez; clicar no item ativo fecha o painel. Avatar abre o editor existente (dialog).
- Badges: não lidas no Chat (total), contagem em Pessoas.
- O chat deixa de ser o painel flutuante à direita e passa a ser o painel da sidebar (mesmo conteúdo/estado: abas Todos/Perto-Sala/DMs, histórico, envio, a11y, gate de teclado).
- A visão geral e o zoom (`ui/cover.ts`) passam a considerar a área ocupada por sidebar + painel (o mapa encaixa no espaço livre).
- HUD atual (faixa de sala no canto, botão Personalizar no canto, latência, Sair) é reorganizado: faixa de sala vira parte do mini-perfil/topo do mapa conforme ficar melhor; latência discreta (rodapé da sidebar ou canto); Sair vai para Configurações.

### B. Painéis

- **Pessoas**: lista (move do chat) com avatar (cabeça renderizada pelo compositor existente), nome, onde está (sala ou "perto"/"no escritório"), indicador de fala/mic se houver mídia; ações: mensagem direta, "Ver no mapa" (entra na visão geral e destaca a pessoa por alguns segundos — destaque visual simples no canvas). Busca por nome quando houver muitos.
- **Salas**: lista das zonas do mapa (nome, tipo reunião/privada, quem está dentro com mini-avatares) + "Escritório aberto" e "Copa" (sem zona, por proximidade); ação "Ver na visão geral" (entra na visão geral e destaca a sala).
- **Configurações**: dispositivos (microfone, câmera e saída de áudio via `enumerateDevices` + `room.switchActiveDevice` do LiveKit, só quando houver mídia; lembrar escolha), **tema** (sistema/claro/escuro — via atributo no `<html>` respeitando os tokens atuais; sem inline style), zoom padrão (redefinir), **Sair** (OIDC).
- **Avatar**: abre o editor; mini-perfil mostra o avatar atual.

### C. Responsivo e acessibilidade

- ≥ 900 px: sidebar fixa (expandida/recolhida) + painel ao lado. < 900 px: gaveta modal (foco preso, Esc fecha, scrim), painel ocupa a gaveta.
- `nav` com `aria-label`, itens como botões com `aria-pressed`/`aria-expanded`/`aria-controls`, atalhos de teclado opcionais (ex.: `Alt+1..5`) que respeitam os donos do teclado (chat/editor), foco visível, `prefers-reduced-motion`.
- Teclado do jogo não deve mover o avatar com foco em campos da sidebar (gate existente).

## Fora

- Calendário/eventos, status personalizado, notificações do sistema, persistência em servidor das preferências.

## Critérios de aceite

- Sidebar expande/recolhe com animação curta, estado lembrado; gaveta no celular.
- Chat, Pessoas, Salas, Configurações funcionam pelos painéis; Avatar abre o editor.
- Visão geral encaixa o mapa no espaço livre com sidebar/painel abertos.
- Troca de tema e dispositivos funciona; zero violações de CSP; claro/escuro; teclado e leitor de tela.
- `npm test`, `npm run build`, `go test ./...` verdes; e2e existentes (avatars, zoom, chat) ajustados e passando; screenshots para revisão.
