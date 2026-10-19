# Fase 6.3 — Avatares personalizáveis

Base: fases 1–6 (`phase1-protocol.md`, `phase6.md`). Mesmos padrões: Go idiomático, stdlib, comentários mínimos, TS sem `any`, CSP restritiva, arte CC0 no repo público, gerada de forma reprodutível (`tools/officeart` ou ferramenta irmã).

## Decisões do usuário

- Avatares **personalizáveis com escolha simples**: tom de pele, cabelo (estilo e cor), roupa (camisa/calça) — a partir de um conjunto fixo.
- Visual de referência: personagens pixel art do Gather (captura `~/Imagens/Capturas de tela/Captura de tela de 2026-10-19 15-26-31.png`), coerentes com o mapa Kenney recolorido e o tema CondoConta.

## Complexidade

Score 14 (complexo): arte nova com animação, protocolo novo (aparência), UI de edição, ordenação de profundidade.

## Escopo

### A. Arte

- Personagem em camadas combináveis (corpo/pele, calça, camisa, cabelo, opcional acessório), **4 direções** e **animação de andar** (≥ 2–3 quadros) + parado.
- Tamanho: maior que 1 tile em altura (ex.: 16×24 desenhado → 32×48 no jogo), pés no tile da posição, cabeça avançando para o tile de cima.
- Paletas: ~5 tons de pele, ~6 estilos × ~8 cores de cabelo, ~8 cores de camisa, ~4 de calça. Combinação por troca de paleta em runtime ou atlas pré-gerado — decidir no refinamento (tamanho vs. flexibilidade).
- Avaliar no refinamento: Kenney Roguelike Characters (CC0, combinável, só de frente), "Customizable character pack" (OpenGameArt, CC0), outras bases CC0 com 4 direções e andar; ou desenho próprio em grade de texto no estilo do projeto.

### B. Protocolo e servidor

- `Appearance` validada no servidor (índices dentro dos conjuntos; desconhecido → recusa), parte de `Player` em `welcome`/`joined`.
- Cliente envia `appearance` (C→S) ao entrar (preferência salva no navegador) e ao mudar; servidor valida, guarda por identidade (memória, como a última posição) e faz broadcast `appearance` {id, ...}. Rate limit para mudanças.
- Sem preferência: aparência padrão **derivada do id** (estável, variada).
- Sem banco de dados nesta fase (preferência vive no `localStorage` do usuário; servidor guarda em memória enquanto o processo vive).

### C. Cliente

- Renderização com animação por direção ao andar (tween existente entre tiles) e parado; **ordenação por y** entre avatares (e com decor alto, se necessário).
- Rótulo de nome continua acima da cabeça; indicador de fala (anel) adaptado ao novo formato.
- Editor: botão no HUD ("Personalizar"), modal acessível com prévia animada, opções por categoria (cores como amostras, estilos como miniaturas), "Aleatório", salvar/cancelar; tema CondoConta; teclado e leitor de tela.
- Tiles de vídeo/presentes podem mostrar a cabeça do avatar (opcional).

## Fora

- Itens premium, animações de emote, persistência em banco, upload de imagem.

## Critérios de aceite

- Avatar anda animado nas 4 direções; outros veem a aparência escolhida e mudanças ao vivo.
- Aparência inválida recusada pelo servidor; padrão estável por id.
- Editor usável por teclado, sem violações de CSP, nos temas claro/escuro.
- `go test -race`, `npm test`, `npm run build` verdes; screenshots para revisão.

---

# Refinamento técnico (vence o texto acima em caso de conflito)

## Divisão

- **6.3a — arte e pipeline:** `internal/avatar` (catálogo: contagens, paletas, rótulos pt-BR, chaves, pools do padrão; fonte única importada pelo gerador e pelo servidor), arte em grade de texto, `tools/officeart/avatars.go`, PNG/TS/CSS gerados, golden, folha de conferência + GIF andando. **Portão: usuário aprova a folha/GIF.**
  - Estado (2026-10-19): implementada — `internal/avatar`, `art/custom/avatar/*.txt`, `tools/officeart/avatars.go` (`make art`; `-sheet` gera `avatars.png`, `avatar-parts.png` e `avatars.gif`), PNG/TS/CSS gerados com golden; **aguarda aprovação da folha/GIF**.
  - Acréscimo (2026-10-19): estilo **Careca** (cabelo 6, `avatar.Bald`) no fim da lista; fora dos pools do padrão. Não desenha cabelo: a cabeça é a do `body` e a linha do estilo tem só o brilho do couro cabeludo (`ScalpShine`, translúcido) nas 3 vistas. No gerador, só essa linha dispensa as chaves de cor de cabelo (exige o brilho e só ele); os demais estilos seguem exigindo as chaves. No editor, com Careca o grupo "Cor do cabelo" fica desabilitado com o selo "Sem cabelo" e guarda a cor escolhida; "Aleatório" pode sortear careca e nunca devolve um careca igual ao atual só com outra cor de cabelo.
- **6.3b — servidor e protocolo** (depende só de `internal/avatar`).
- **6.3c — renderização no cliente** (depende de 6.3a e 6.3b).
- **6.3d — editor** (depende de 6.3c).

## Arte (6.3a)

- **Desenho próprio** em grade de texto (nenhuma base CC0 tem camadas + 4 direções + andar + > 1 tile). Plano B: Kenney RPG Urban/rubberduck 16×16 escalado (pipeline com tamanho de quadro configurável).
- Quadro **16×24** desenhado → 32×48 no jogo. Vistas desenhadas: baixo, cima, direita (esquerda = espelho). 3 quadros: parado, passo A, passo B. Cabelo/acessório estáticos por vista + `bob = [0,1,1]` px por quadro. Contorno `26292e`; sombra `00000040`. Geometria: cabeça/cabelo linhas 0–10, tronco 11–17, pernas/sapatos 18–23 (linha 23 = pé no fundo do tile).
- Camadas em `art/custom/avatar/`: `body.txt` (cabeça, rosto, sombra), `pants.txt`, `shirt.txt` (tronco, braços, mãos no tom de pele), `hair.txt` (7 estilos × 3 vistas), `acc.txt` (óculos, fone, boné × 3 vistas).
- **Recolor por cor-chave**: cada camada desenhada com o índice 0 da paleta do papel; composição troca cores exatas por papel. Gerador falha se: chave sem uso (exceto as de cabelo no estilo Careca, que não pode usá-las), pixel fora de chaves/cores fixas, chaves repetidas.
- Paletas (claro/base/sombra; índice 0 = chave):
  - Pele (5): `F7D7BC/EDBE9A/D29A76`, `EEC08F/DCA06F/BB7F53`, `CF9564/B67A4A/935E36`, `9E6843/845332/663E25`, `6E452B/583621/402617`.
  - Cabelo, estilos (7): Curto, Topete, Cacheado, Longo, Coque, Raspado, Careca (sem cabelo: só o brilho do couro cabeludo; a cor do cabelo não aparece). Cores (8): Preto `4A4850/2F2D33/1C1B1F`, Castanho-escuro `6E4A35/4E3325/352219`, Castanho `A06A40/7E4F2D/5B371F`, Ruivo `DE7A43/B9552E/8C3D20`, Loiro-escuro `DDB86A/C29848/9A7534`, Loiro `F7E6A6/E8CF7A/C4AA58`, Grisalho `D2D4D8/A9ACB2/7F838A`, Azul `5A8FC4/2F5D8A/1F3F60`.
  - Camisa (8): Marinho `3F6286/1F3C5A/152B42`, Amarelo `FFD766/FDC339/D9A21F`, Branco `FFFFFF/EEF0F3/C5CBD5`, Cinza `B5BCC8/8D97A8/6B7486`, Vermelho `E07F72/C4473B/98342B`, Verde `6DB27C/3E8A52/2A6139`, Azul-claro `9ACDF6/5AA9F0/3B86CA`, Roxo `A57AD0/7A3FB0/5A2C85`.
  - Calça (4, base/sombra): Jeans `4A6A99/344E75`, Preta `3D4048/2A2C32`, Cáqui `C4AE82/9E8A62`, Cinza `7A8191/5B6170`.
  - Acessório (4, cores fixas): Nenhum; Óculos (`26292E`, lente `CFE3F2`); Fone (`33363D`, almofada `F2B632`); Boné (`213F5E`, aba `16304A`, ponto `FDC339`).
  - Fixas (`internal/avatar`, `Fixed()`): olhos `26292E`, brilho dos olhos `F5F1EA`, sapato `3A3F4B`, sola `26292E`, sombra `00000040`, brilho do couro cabeludo `FFFFFF73` (só no estilo Careca). Nenhuma fixa pode ser igual a uma chave.
- Saídas: `web/public/game/avatar-parts.png` em **1×** (12 colunas = baixo/esquerda/direita/cima × parado/A/B; 13 linhas = body, pants, shirt, 7 cabelos, 3 acessórios; 192×312; cresce com o catálogo), `web/src/avatar/catalog.gen.ts`, `web/src/avatar/swatches.gen.css` (classes `.swatch-<cat>-<i> { --swatch: #hex }`). `-sheet` gera `avatars.png` (conferência) e `avatars.gif` (andando nas 4 direções, `image/gif` stdlib). `parseSprite` deixa de exigir múltiplos de 16 (checagem vai para quem chama).

## Servidor e protocolo (6.3b)

- `Appearance = { skin, hair, hairColor, shirt, pants, acc }` (uint8); ausente = 0, chave desconhecida ignorada. `Player.appearance` sempre preenchido em `welcome`/`joined`. Forma compacta `"skin.hair.hairColor.shirt.pants.acc"` (campos finais ausentes = 0; extras = inválido) com Parse/String em Go e TS.
- Tipo errado/negativo/fracionário/> 255 → close 1008. Índice fora do catálogo → sem close: só o remetente recebe `appearance` com a atual (log debug).
- Catálogo **só cresce no fim** (nada removido/reordenado); cliente troca índice desconhecido por 0.
- Padrão por id: FNV-1a 64 → base mista sobre **pools congelados** (skin 0–4, hair 0–5, hairColor 0–6, shirt 0–7, pants 0–3, acc `[0,0,0,1]`). Só o servidor calcula.
- C→S `appearance` {Appearance}; S→C `appearance` `{id, appearance}` a todos quando muda (se não mudou, só ao remetente).
- `GET /ws?av=<compacta>` aplicado antes do `welcome` (sem flash do padrão); inválido/ausente → memória → padrão; nunca recusa o upgrade. Substituição com aparência diferente também gera `joined`.
- Rate limit por identidade (generalizar `chatLimits` → `identityLimits{rate, burst}`): 0,2/s burst 3, gasto após validação; estouro → só o remetente recebe a atual.
- `world.Player.Appearance` (struct comparável), `lastSeen.look` junto do `last` (cap 1000); `Join` aplica memória/padrão; `SetAppearance(id, a) (Player, bool)`.
- Atualizar testes que comparam `Player` inteiro e `phase1-protocol.md`. loadbot não muda (opcional flag `av`).

## Cliente (6.3c)

- `load.spritesheet` do `avatar-parts.png` (16×24); por aparência compõe 5 camadas numa canvas 192×24, `recolor()` puro sobre `ImageData`, `textures.addCanvas('avatar:<compacta>')`; cache com contagem de referências. 1 Sprite por avatar, `setScale(2)`, origem (0.5, 1) em y = +16.
- Animação pelo tween do passo (150 ms): A → parado → B → parado (75 ms), via `frameFor(dir, stride, progress)` puro. `face()` mantém a pose (não zera no meio do passo).
- Profundidade `10 + y` (atualizada no `onUpdate`/`snapTo`); rótulo dentro do container em `LABEL_BOTTOM = -34`; anel de fala vira elipse 24×8 nos pés; clique no sprite 32×48 com `topOnly`. `BootScene` perde `createAvatarTexture`. `upsert` atualiza aparência; `OfficeScene` trata `appearance`. Guard TS aceita `Player` sem `appearance` (fallback).

## Editor (6.3d)

- Botão "Personalizar" no `.hud-corner` (`brand`, ícone `shirt` do lucide-static 1.59.0 no sprite; só ícone em telas estreitas), habilitado após `welcome`.
- `<dialog id="avatar-editor">` com `showModal()` (foco preso, Esc cancela, foco volta); `<form method="dialog">`; prévia `<canvas 64×96 role="img" aria-label>` com `imageSmoothingEnabled = false`, animando via `frameFor` a cada 150 ms e girando direção (parada com `prefers-reduced-motion`; botão "Girar"); `<fieldset><legend>` por categoria com **radios nativos** e amostras `.swatch-chip.swatch-<cat>-<i>` (cores via classes geradas, sem inline style); estilos de cabelo/acessórios como miniaturas `<canvas aria-hidden>`; ações Aleatório (diferente do atual), Cancelar (reverte), Salvar (localStorage + `appearance`).
- `TypingGate` vira conjunto de donos (chat e editor). `avatar/prefs.ts` com chave `vb-office-32.avatar` (compacta, try/catch, validada). `Connection` recebe URL como função (`() => wsUrl(name, pref())`).
- e2e `web/e2e/avatars.mjs` (CDP): andar 4 direções, editor por teclado, outro cliente recebe `appearance`, reload mantém, zero CSP, claro/escuro, 1280×800 e 390×844.

## Riscos aceitos

Cabeças podem cobrir parcialmente placas de sala (revisar em screenshots); ~200 texturas aceitável; espelhar a vista lateral inverte detalhes assimétricos; cabeça do avatar em tiles de vídeo/presentes → backlog.
