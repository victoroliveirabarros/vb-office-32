# Fase 6 — Identidade visual: mapa em pixel art e interface aconchegante

Base: fases 1–5. Mesmos padrões: Go idiomático, comentários mínimos, TS sem `any`, CSP restritiva (sem inline, fontes e imagens do próprio host). Repositório público open source.

## Decisões do usuário

- Escopo desta fase: **mapa (tileset)** e **interface (HUD, chat, barra de mídia, faixa de sala, telas de login/nome)**.
- Direção: **aconchegante estilo Gather** — pixel art colorida e acolhedora, UI com cantos arredondados, tons quentes.
- Arte: **Kenney (CC0)**. Nada com licença que impeça redistribuição no repo público.
- Avatares personalizáveis (escolha simples de pele/cabelo/roupa) ficam para a **fase 6b** — não implementar agora, mas não fechar portas (ex.: atlas de personagem separado do tileset).

## Complexidade

Score 12 (médio): assets externos, redesenho do mapa, mudança de renderização, sistema de design na UI, sem mudança de protocolo.

## Escopo

### A. Tileset e mapa

- Escolher pack(s) Kenney top-down de interior adequados a escritório (piso, carpete, madeira, paredes com profundidade, portas, mesas, cadeiras, computadores, plantas, sofás, estantes, quadros/telas). Confirmar licença CC0 no arquivo de licença do pack e registrar em `CREDITS.md` (mesmo sem obrigação).
- Tile do jogo continua **32 px** (servidor, zonas e cliente assumem 32): se o pack for 16 px, escalar 2× com nearest-neighbor num passo reprodutível (script versionado, ex.: `tools/` ou `cmd/`), versionando o PNG final em `web/public/assets/`.
- `office.tmj` redesenhado com o tileset real mantendo **a mesma planta lógica**: mesmas salas/zonas (Sala 1, Sala 2, Cabine), mesmas portas, spawns fora de zonas, todo tile livre alcançável (o teste existente precisa continuar passando). Camadas: `floor`, `walls` (colisão: gid ≠ 0 bloqueia — móveis sólidos vão aqui), nova **`decor`** opcional (sem colisão, desenhada acima do piso/abaixo dos avatares ou acima conforme o caso), `zones`, `spawns`.
- Servidor: aceitar a camada extra `decor` (deve ser ignorada pela colisão). Se o loader recusar camadas desconhecidas, ajustar minimamente.
- Cliente: carregar o PNG real em vez da textura gerada em runtime; renderizar `decor`; `pixelArt` nítido; overlay de zonas revisado para combinar com a arte (mais sutil).

### B. Interface (sistema de design)

- Tokens CSS em `:root` (cores, raios, sombras, espaçamentos, tipografia), paleta quente e acolhedora com contraste AA; tema claro padrão e escuro via `prefers-color-scheme`.
- Fonte legível e amigável **self-hosted** (licença OFL, ex.: Nunito/Quicksand/Inter — decidir no refinamento) em `web/public/fonts`, `font-src 'self'`.
- Ícones SVG (licença MIT/ISC/CC0, ex.: Lucide/Phosphor) para mic, câmera, tela, chat, sair, fechar — arquivos ou sprite, sem inline style; botões com rótulo acessível.
- Restilizar: painel de chat (abas, mensagens, input, lista de presentes), barra de mídia (botões redondos com estados ligado/desligado/erro), tiles de vídeo (bolhas arredondadas com nome), palco de tela, faixa de sala, avisos/status, telas de entrada (login OIDC e nome guest), nomes dos avatares no mapa (rótulo legível sobre a arte).
- Responsivo (já existe painel recolhido < 900 px) e foco visível para teclado.

## Fora

- Avatares personalizáveis e animação de personagem (6b), sons, temas por usuário, novas salas.

## Critérios de aceite

- Mapa com arte Kenney, nítido, mesma jogabilidade (colisão, portas, zonas) e testes do mapa verdes.
- UI coerente com a direção "aconchegante": tokens únicos, fonte self-hosted, ícones, claro/escuro, contraste AA nos textos principais.
- Zero violações de CSP; build sem regressão relevante de tamanho (reportar).
- Screenshots antes/depois (1280×800 e 390×844) para revisão do usuário.
- `go test -race ./...`, `npm test`, `npm run build` verdes.

---

# Refinamento técnico (vence o texto acima em caso de conflito)

Verificado em 2026-10-19 (licenças lidas nos `License.txt` dos zips).

## Subfases

- **6.1 — Mapa:** art/, tools/officeart, atlas, tmj gerado, testes, Boot/OfficeScene, overlay, CREDITS.
- **6.2 — UI:** tokens, fonte, sprite de ícones, restilização, tema escuro, rótulo de nome.
- **6.3 — Avatares personalizáveis** (antes chamado "6b").

## Decisões (D)

- **D1 (aprovada pelo usuário):** computadores e TV não existem nos packs → 3–4 sprites próprios 16 px na paleta Kenney (monitor de frente, monitor de costas, TV de parede 2×1) em `art/custom/`, CC0.
- **D2:** máscara de bloqueio **idêntica** à atual (cada gid ≠ 0 em `walls` continua bloqueado; só a arte muda). Zonas, portas, spawns e o BFS de `TestOfficeMap` passam por construção.
- **D3:** paredes de 1 tile com autotile: parede com tile livre ao sul vira **frente**; resto vira **topo** pela máscara de 4 vizinhos; ponta de frente ao lado de porta vira batente. Porta = vão sem folha.
- **D4:** uma camada `decor` (sem colisão, depth 3, acima de `walls` e abaixo dos avatares em 10); regra de desenho: nenhum sprite passa do próprio retângulo bloqueado, exceto sobre parede. Sem `overhead`, sem ordenar por y. Cadeiras e monitores sobre mesas em `decor`.
- **D5:** atlas só com os tiles usados (~80–90), escala 2× nearest-neighbor, **extrusão de 1 px** por tile; no Tiled `margin: 1`, `spacing: 2`, 16 colunas (~544×205 px). Tileset embutido no `.tmj` com `name: "office"`, `image: "../web/public/game/office-tiles.png"`.
- **D6:** assets do jogo em `web/public/game/` (não `public/assets/`, que colide com `dist/assets` do Vite).
- **D7 (6.3):** Roguelike Characters 2.0 (CC0, partes combináveis, mesma paleta, só de frente — andar simulado com tween/flip); avaliar "Customizable character pack" do rubberduck (OpenGameArt, CC0) se andar em 4 direções for obrigatório.
- O servidor **já aceita** `decor` (loader busca camadas por nome); só adicionar fixture de teste.

## Packs e tiles (coordenadas (coluna, linha) base 0)

- **Roguelike/RPG pack** (https://kenney.nl/assets/roguelike-rpg-pack): `roguelikeSheet_transparent.png`, 16 px, 57×31, margin 0, spacing 1.
- **Roguelike Indoors** (https://kenney.nl/assets/roguelike-indoors): `roguelikeIndoor_transparent.png`, 16 px, 27×18, margin 0, spacing 1.
- Piso claro: RPG (7,29) (alt. cinza (4,29)). Carpetes 9-slice alinhados às zonas: Sala 1 teal RPG (15..17,25..27); Sala 2 verde (9..11,25..27); Cabine laranja (12..14,25..27). Madeira (copa): RPG (5,2) (alt. (8,2)).
- Paredes bege: topo horizontal (14,12), vertical (15,13); cantos: sup. esq. (16,12), sup. dir. (17,12), inf. esq. (16,13), inf. dir. (17,13); T (18..19,12..13); pontas (13,12), (15,12), (13,13), (13,14); frente alta (18,15), frente com rodapé (13,15); pontas de frente/batente (17,15)/(19,15) e (14,15)/(16,15).
- Indoors: mesa longa 3×2 (0..2,0..1) (coluna do meio repete); mesas de 1 linha (4..7,4); oval (3..4,0..1); cadeiras (0,8) frente, (1,8) costas, (2,8) direita, (3,8) esquerda; vasos (16,0),(17,0); sofás 2×1 (14..15,7) laranja, (12..13,7) verde, (14..15,8); poltronas (8,6),(9,6); quadros (19,12..14); painéis 2×1 (20..21,12..14); espelho/quadro branco (22,14..15); passadeiras (16..18,14..17); balcões (0..9,12) com pia (8,12); fogão (14,14); geladeira (14,16..17) a confirmar. Estantes RPG (41..48,12..14).
- **Coordenadas precisam de conferência visual**: o gerador deve emitir uma folha de conferência (PNG com índices) no scratchpad antes de fechar.

## Planta nova (revisão da 6.1, vence D2 e "mesma planta lógica")

A pedido do usuário, a planta passou a seguir o esboço dele (mapa 50×25, tile 32 px):

```
              ┌ reunião (14×8) ┐┌ copa (11×8) ┐
┌ privada ───┐├──────── office (26×14) ─────┤┌ ringue ────┐
│ 10×7       ││  15 mesas                    ││ 10×7       │
└────────────┘│                              │└────────────┘
              └──────────────────────────────┘
```

- Zonas: `reuniao` "Sala de reunião" `meeting` (tiles x 12..25, y 1..8); `privada` "Sala privada" `private` (x 1..10, y 10..16); `ringue` "Ringue de box" `private` (x 39..48, y 10..16). A copa (x 27..37, y 1..8) não é zona: conversa por proximidade, como no office.
- Uma porta por sala, sempre para o office: reunião (18..19, 9), privada (11, 13..14), ringue (38, 13..14); a copa abre em (29..35, 9). Portas e os 10 spawns (faixas livres do office, linhas 11 e 18) ficam fora das zonas.
- Fora do contorno do prédio (os quatro cantos) o tile é `~` nas grades `floor` e `solid`: sem piso e bloqueado por um tile transparente `outside` em `walls`, então aparece o fundo da página (tema claro/escuro). Paredes com `~` ao sul viram topo, não frente.
- Office: 3 ilhas num carpete cinza (x 13..36, y 12..17), cadeiras dos dois lados como no Gather (referência do usuário). Cada ilha é uma mesa de escritório 6×2 (`D`, sprite próprio `office-desk`: tampo de madeira com divisória baixa entre as fileiras) em x 14..19, 22..27 e 30..35, y 14..15, com estações de 2 tiles por pessoa: monitor com teclado e mouse (`m`, de costas para quem senta ao norte, de frente para quem senta ao sul) e ao lado um acessório (`n` papéis e caneca, `b` livros e celular, `l` luminária, `p` suculenta). Três estações ao norte (cadeiras em y 13) e duas ao sul (y 16), desencontradas; a terceira vaga ao sul tem só a suculenta: 15 estações. Corredores de 2 tiles entre as ilhas e nas pontas, faixa livre acima (y 10..12) e abaixo (y 17..18); embaixo, à esquerda, um lounge (sofá, poltronas e mesinha num tapete bege), à direita uma mesa de apoio para 6 num tapete cinza e, no meio, passadeira entre dois vasos; estantes, plantas e banco junto à parede sul. Cadeiras de escritório próprias (`office-chair`, grafite, 4 direções) no office, na reunião e na privada; a copa mantém as cadeiras de madeira do Kenney (`h`). Reunião com mesa 6×2 de 16 lugares e TV; privada com mesa para 6; copa com geladeira, balcões, pia, fogão, mesa de 6 e cantinho com sofá, poltronas e mesinha num tapete bege. Spawns nas faixas livres do office, y 11 e 18 (x 14, 19, 24, 29, 34).
- Ringue: sprites próprios CC0 em `art/custom/` — `ring` (lona 9-slice com avental e frente elevada ao sul), `ring-ropes` (postes de canto vermelho/azul/brancos e cordas horizontais/verticais), `punching-bag`, `outside`. Postes bloqueiam (só os 4 cantos); cordas são `decor`, então dá para entrar e sair do ringue por qualquer lado. Banco do Kenney (Indoors (10..11, 4)).
- Carpetes: reunião teal, privada laranja, ringue cinza (corre por baixo da lona), tapete da copa bege, cinza sob as ilhas do office.
- Faixa de sala no HUD não repete o tipo quando o nome já o diz: "Sala de reunião", "Sala privada", "Ringue de box — privada".

## Pipeline

- `tools/officeart/` (Go stdlib; não `cmd/`), `go run ./tools/officeart`, alvo `make art`. Fontes versionadas: as duas folhas PNG + `License.txt` em `art/kenney/<pack>/`, sprites próprios em `art/custom/` (não versionar zips/amostras).
- Manifesto ordenado nome → (folha, col, linha); ordem define índice no atlas.
- Mapa gerado de planta ASCII embutida (`office.txt`, três grades 40×25: floor/solid/decor; legenda ex.: `,` piso, `1/2/3` carpetes, `w` madeira; `#` parede, `T` mesa, `D` escrivaninha, `K` balcão, `P` planta, `S` sofá, `V` TV; `c` cadeira (orientação pela mesa vizinha), `m` monitor, `q` quadro, `e` estante). Retângulos do mesmo caractere viram peças 3/9 partes. Zonas e spawns como literais Go com os valores atuais.
- Teste golden `tools/officeart/officeart_test.go`: regenera em memória, compara `.tmj` como JSON e PNG por pixels, roda `tilemap.Load`.
- `CREDITS.md` na raiz (Kenney com versão/URL/CC0/sha256; Nunito OFL 1.1; Lucide ISC + MIT Feather; `art/custom` CC0), link no README.

## Cliente (6.1)

- `BootScene`: remover `createTilesTexture`; `this.load.image(TILES_KEY, '/game/office-tiles.png')`. Textura do avatar continua runtime até 6.3.
- `OfficeScene`: `createLayer('decor', tileset)?.setDepth(3)`; overlay de zona sem preenchimento (carpete já delimita), só contorno arredondado 2 px alpha ~0,4 na sala atual + placa em pílula com o nome. Zoom inteiro mantido. `transparent: true` no game config (fundo pelo CSS/tema).

## UI (6.2)

- Tokens (claro / escuro), todos AA calculados: `--bg` #F6EFE4/#1E1A17; `--surface` #FFFBF5/#2A2420 (alpha ≥ 0,94 sobre o mapa); `--surface-2` #F3EADD/#352E29 (botão #3D3530); `--border` #E3D5C2/#4A403A; `--text` #3B2F28/#F4ECE2; `--text-muted` #6B5B50/#C4B5A6; `--primary` #B4532F (texto #FFF, hover #9C4526) / #E8875E (texto #2A1810); `--success` #3A7A4B/#6CC08A; `--danger` #B23A3A/#EC7B7B; `--warning` #E8A93E/#F0B858; `--error-text` #A8322F/#FF9A90; nome no chat #3D5C9E/#9DB8F0, nome próprio #2F7346/#8FD6A4; `--focus` #2F6FD0/#7FB0FF; badge #C2410C texto #FFF. Zonas no mapa: reunião #5B8DD6, privada #9B6BC8.
- Raios 6/10/16/999; espaços 4/8/12/16/24/32; sombras quentes (claro `0 1px 3px rgb(59 47 40/.12)`, `0 4px 12px rgb(59 47 40/.16)`, `0 12px 32px rgb(59 47 40/.22)`; escuro mesmas com `rgb(0 0 0/.4)`); base 14 px, line-height 1,4, escala 12/13/14/16/20, pesos 400/600/700/800; `color-scheme: light dark`; escuro via `prefers-color-scheme`; `prefers-reduced-motion` desliga transições.
- Fonte **Nunito variável** (OFL 1.1) de `@fontsource-variable/nunito@5.3.0`: `nunito-latin-wght-normal.woff2` + `nunito-latin-ext-wght-normal.woff2` + `OFL.txt` em `web/public/fonts/` (sem dependência npm), `@font-face` com `unicode-range` e `font-display: swap`.
- Ícones **Lucide** (`lucide-static` 1.59.0, ISC): sprite `web/public/icons.svg` só com os símbolos usados (mic, mic-off, video, video-off, screen-share, screen-share-off, message-circle, log-out, x, users, volume-2, circle-alert, send) + `icons-LICENSE.txt`; uso `<svg aria-hidden="true"><use href="/icons.svg#mic"/></svg>`; estados ligado/desligado com dois `<svg>` alternados via `[aria-pressed]`; cor `currentColor`.
- Componentes: overlays de login/nome (cartão surface, raio 16, sombra 3, botão primário pílula, input raio 10, scrim `rgb(43 33 27/.55)`); faixa de sala/status/latência em pílulas; Sair ghost pílula com ícone; barra de mídia com botões redondos 44 px (ligado surface-2; desligado danger com ícone branco; erro ponto warning; ocupado opacidade 0,6 + `cursor: progress`; tela com ícone+texto, só ícone < 600 px); tiles de vídeo raio 16, sombra 2, nome em pílula; palco raio 16; chat raio 16, abas pílula (selecionada em tom suave do primary), nome colorido + hora muted, input raio 12, Enviar pílula primária com ícone; presentes com tags pílula; × via sprite; `:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px }`.
- Rótulo de nome no canvas: pílula `Graphics.fillRoundedRect` #2B2420 alpha ~0,78, texto branco Nunito 700 11 px; `label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)`; `resolution` = zoom × devicePixelRatio (máx. 4); `await document.fonts.load('700 11px "Nunito"')` com timeout curto antes do `new Phaser.Game`.
- CSP: nada muda (fontes/atlas/sprite same-origin; `data:` em img-src continua para texturas do Phaser).
- Screenshots "antes" (1280×800 e 390×844) a partir do commit anterior à 6.1; tamanho do build antes/depois.

## Tema corporativo (revisão da 6.2, vence tokens, fonte, raios, sombras e rótulos da UI 6.2)

Cores e fonte seguindo a identidade da CondoConta, sem logos nem assets da marca (repo público).

- Base azul-marinho + amarelo. Superfícies de marca (classe `.brand`: faixa de sala, status, latência, Sair, barra de mídia, botão e cabeçalho do chat) em `--brand` #00263E (escuro #001B2D com borda #25496A), texto #FFF, secundário #B7C3D1, botões internos `--brand-2` #0E3A58 (hover #194B6E); dentro delas o foco é amarelo.
- CTA `--accent` #FDC339 (hover #F5B41C claro / #FFD366 escuro), texto #00263E: Entrar, Enviar, Ativar áudio, "Compartilhar tela" ativo (Parar), badge de não lidas, indicador da aba selecionada (borda inferior 3 px) e faixa de 4 px no topo dos cartões. CTA desabilitado vira botão neutro com texto secundário.
- Tokens claro / escuro: `--bg` #F6F6F6/#00131F; `--surface` #FFF/#06253A (alpha 0,98 sobre o mapa); `--surface-2` #F4F5F8/#0C3049; `--button` #ECEFF3/#0F3552; `--border` #DDE0E8/#25496A; `--text` #333/#E9EEF4; `--text-muted` #697081/#A3B2C4; `--link` #014C8B/#7DBDFF; `--focus` #014C8B/#FDC339; `--primary-soft` #E5EEF7/#123C5E (texto #014C8B/#A9D3FF); `--success` #1E7A37 (texto #FFF) / #5CCB7E (texto #00263E); `--danger` #C42B0E (hover #A8240B, ícone #FFF) nos dois; `--warning` #F2A900/#F5B83D (pontos), `--warning-text` #8A5C00/#F5C35C; `--error-text` #B8290D/#FF9580; nome no chat #014C8B/#7DBDFF, próprio #1E7A37/#6FD493. Status da empresa ajustados para AA: erro #EC320D → #C42B0E (branco 5,68:1), aviso #9A6600 → #8A5C00 (texto); sucesso #1E7A37 mantido.
- Contrastes (claro / escuro): texto/fundo 11,69/16,17; texto/superfície 12,63/13,50; secundário/superfície 4,96/7,29; secundário/surface-2 4,55/6,34; secundário/fundo 4,59/8,74; HUD branco/azul 15,59/17,58; HUD secundário/azul 8,72/9,83; branco/botão no azul 11,90; CTA #00263E/#FDC339 9,68 (hover 8,49/10,96); indicador da aba e badge amarelo/azul 9,68/10,92; link e nome 8,72/7,95; nome próprio 5,39/8,64; foco/superfície 8,72/9,78, foco/fundo 8,07/11,72, foco amarelo/azul 9,68/10,92; tag "na sala" 7,44/7,33; tag sucesso 5,39/7,65; ícone desligado branco/#C42B0E 5,68; erro 6,25/7,40; aviso 5,81/9,63; ponto de aviso/azul 7,76/9,88; pontos de zona no HUD (#5AA9F0 reunião, #C29BF0 privada) /azul 6,21–7,73.
- Raios 4/8/12/16/999 (botões, inputs e chips do HUD 8; barra de mídia, tiles e botão do chat 12; cartões, painel do chat e palco 16; badges e tags pílula). Sombras `2px 2px 5px rgb(0 0 0/.05)`, `2px 4px 14px rgb(0 0 0/.12)` (HUD, hover do CTA), `0 12px 32px rgb(0 38 62/.18)` (cartões, chat, palco); escuro com preto .3/.4/.5. Scrim `rgb(0 38 62/.6)`/`rgb(0 10 18/.7)`.
- Fonte **Montserrat variável** (OFL 1.1) de `@fontsource-variable/montserrat@5.3.0`: `montserrat-latin-wght-normal.woff2` + `montserrat-latin-ext-wght-normal.woff2` + `OFL.txt` em `web/public/fonts/` (sem dependência npm); preload do latin; pesos 400/500/600/700; `fontReady` espera `700 11px "Montserrat"`.
- Canvas: rótulo de nome em #00263E alpha 0,85, texto branco Montserrat 700 11 px (≥ 9,8:1 sobre qualquer piso); placa de zona preenchida com a cor da zona (reunião #014C8B, privada #7A3FB0, alpha 0,92; branco 8,72/6,63), raio 4 e ponto amarelo #FDC339; contorno da sala na mesma cor, alpha 0,7.

## Piso e paredes corporativos e baias (revisão da "Planta nova")

A pedido do usuário, o mapa ganha a paleta corporativa da UI e as estações viram baias como na referência do Gather. Vence, da "Planta nova", as 3 ilhas de 15 estações, os carpetes teal/laranja/bege e a lona sobre carpete cinza.

- **Recolor no gerador:** `Entry.Paint` (`tools/officeart/manifest.go`) troca cores exatas origem→destino num tile Kenney (ou próprio) mantendo o traço; o gerador falha se uma cor do mapa não aparece em nenhum tile pintado com ela. `index.txt`/`index.png` marcam os tiles pintados (`*`). Sprites em texto aceitam cor translúcida `rrggbbaa`.
- **Paredes:** topo `b4a78c`→`a9afbb`, borda `d9caa9`→`e4e7ec`, contorno `908570`→`5b6170`; frente `d9caa9`→`eef0f3`, rodapé `b4a78c`→`5c6372` (grafite) com contorno `3a3f4b`, filete `e6dabf`→`d3d7de`, batente `c4b79b`→`d9dce2`.
- **Vidro** (`=` na grade `solid`, sprite `glass`): paredes das salas voltadas para o office — reunião (x 12..17 e 20..25, y 9), privada (x 11, y 10..12 e 15..16), ringue (x 38, mesmas linhas). Autotile igual ao das paredes (`glass-` + nome do tile sólido): frente com trilho de alumínio em cima, vidro `a4d0ef` translúcido com reflexo diagonal e rodapé grafite alinhado ao das paredes; topo vertical com caixilho dos dois lados. Os pilares nas junções e a copa continuam sólidos; quadros/janelas só em frente sólida. Bloqueia como parede: a máscara não muda por causa do vidro.
- **Pisos:** office em carpete modular `aeadba`/`a7a6b4` (placas 2×2 por tile, fios alternados); baias em carpete `9d9cab` com moldura `75748a` por estação (`u`, 9-slice por estação de 3 tiles); reunião carpete azul `3a6c9f` (borda `0e3a58`/`5583b5`, era teal `37aaa5`); privada cinza-azulado `7d8ba1` (era laranja `b65e26`); copa porcelanato `e3e6ea` com rejunte `cfd3da` (era pedra `5,2`); ringue emborrachado grafite `4b505d` com grânulos (era carpete cinza), lona azul mantida; tapetes `dedad1` (era bege `d9caa9`) e `c5c9d1` (era `cccccc`); passadeira grafite `7f8696`/`474d5b` (era bege).
- **Móveis:** mesas Kenney brancas (`c8a480`→`eef0f3`, borda `c5cbd5`); sofá azul-marinho `2f4f72`; poltronas `f2b632` e assento das cadeiras de madeira amarelos (eram laranja `c66527`); estantes cinza claro `dfe2e7` com livros azuis `2f5d8a`; painel bege vira quadro branco (`Q`). Bancada, banco, cadeiras de madeira, monitores e cadeiras grafite mantidos.
- **Baias** (12 estações, máscara do office muda — gerado com `-allow-mask-change`): dois blocos de 3×2 baias, x 15..23 e 26..34, mesas (`D`) em y 14..15, cadeiras em y 13 (cinza claro `bfc4cd`, recolor de `office-chair`) e y 16 (azul-marinho `1f3c5a`), corredor de 2 tiles entre os blocos (x 24..25) e de 3 nas laterais. `D` exige 2 linhas e largura múltipla de 3; a mesa (`office-desk`, refeito) é branca `eff1f5` com painéis laterais `8d97a8` e gaveteiros na frente da fileira sul. Itens por baia, todos dentro da mesa: `m` monitor, `d` dois monitores (2 tiles), `k` notebook — de frente na fileira sul e de costas na norte —, `x` computador, `f` aquário (2 tiles), `n` papéis e caneca, `b` livros, `l` luminária, `p` suculenta, `v` planta em vaso, `t` porta-retrato. Plantas novas em (12,16) e (37,16); lounge, mesa de apoio, spawns, zonas e portas mantidos.
- **Canvas:** contorno da sala atual em amarelo `#FDC339` alpha 0,85 (o azul `#014C8B` sumia no carpete azul); placas continuam na cor da zona sobre a parede branca.

## Zoom da câmera e visão geral

- **Níveis:** os inteiros de `zoomRange` (do primeiro que não deixa fundo aparecendo além do mapa nos dois eixos até o mais próximo que ainda mostra 3,5 tiles no lado menor, máx. 4×) e, antes deles, a **visão geral**, que encaixa o escritório inteiro (1600×800) na tela com margem de até 24 px nas laterais e 48 px em cima e embaixo (no máx. 5% do lado). Abaixo de 1× ela é a fração do encaixe; quando o escritório cabe a 1× ou mais, é o maior inteiro que cabe, abaixo dos demais. Padrão por tela: o nível mais próximo que mostra 12 tiles no lado maior e 5,5 no menor.
- **Por tela:** 1280×800 → visão geral 0,77×, 1–4× (padrão 3×); 1366×768 → 0,82×, 1–4× (3×); 1920×1080 → visão geral 1×, 2–4× (4×); 390×844 → 0,22×, 1–3× (2×); 844×390 → 0,44×, 1–3× (2×).
- **Painel aberto:** com o chat aberto a visão geral encaixa o escritório no lado livre do painel onde ele fica maior (à esquerda no desktop: 0,535× em 1280×800; acima da folha no celular) e se reajusta ao abrir/fechar o chat (`ResizeObserver` em `#chat-panel`). Os níveis inteiros não mudam com o painel.
- **Câmera:** nos inteiros segue o avatar dentro do mapa (`cameraBounds`); na visão geral para de seguir e centraliza o escritório na área livre; andar com as setas não mexe a câmera. Entrando e saindo da visão geral a câmera desliza (pan + zoom, 180 ms, `Quad.easeOut`) até o centro do escritório ou até onde seguir o avatar a coloca no nível de chegada, e volta a segui-lo ao terminar. `prefers-reduced-motion`: sem animação. Clique não muda o zoom.
- **Controles:** + / − / redefinir; teclas `+`/`=`, `-`, `0` (não enquanto o chat ou o editor têm o teclado; Ctrl/⌘ ficam com o navegador); roda do mouse comum ou com Ctrl/⌘ sobre `#game` (para cima aproxima), com `preventDefault` só ali — chat e painéis continuam rolando; pinça no celular (níveis comparados em escala logarítmica, histerese de 10% do intervalo). Um entalhe de roda é um passo; um gesto de trackpad (rolagem ou pinça, com a inércia) é um passo só, até uma pausa de 200 ms; o − e a pinça chegam à visão geral.
- **Indicador e acessibilidade:** o nível aparece como `3×`; na visão geral, o ícone `map` (Lucide) em amarelo; − desabilitado (`aria-disabled`) nela. `role=status` anuncia "Zoom 3×" ou "Visão geral do escritório".
- **Preferência:** `localStorage['vb-office-32.zoom']` guarda o inteiro ou `overview`; redefinir apaga. Um inteiro é limitado ao que a tela permite; a visão geral é refeita para cada tela.
- **Render abaixo de 1×:** o atlas do mapa passa a filtro LINEAR (os tiles têm 1 px de extrusão, sem costuras) e volta a NEAREST nos inteiros, onde tudo fica nítido. Avatares nunca menores que a arte original na tela (escala `max(2, 1/zoom)`: 1:1 nítido no celular); quando a escala na tela é fracionária usam `setSmoothPixelArt`. Nomes mantêm o tamanho de 1× na tela (11 px, `resolution` pela escala efetiva × DPR) logo acima da cabeça; o contorno da sala também. As placas mantêm o tamanho de 1× na parede enquanto cabem nela (até 0,5×); abaixo disso vão para o canto inferior esquerdo dentro da sala, opacas, longe dos nomes, encolhendo até 80% se a sala for estreita e sem passar da borda do mapa.
