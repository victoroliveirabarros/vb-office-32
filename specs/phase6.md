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
- Paredes bege: topo horizontal (14,12), vertical (15,13); cantos (16,12) SE? — sup. esq. (16,12), sup. dir. (17,12), inf. esq. (16,13), inf. dir. (17,13); T (18..19,12..13); pontas (13,12), (15,12), (13,13), (13,14); frente alta (18,15), frente com rodapé (13,15); pontas de frente/batente (17,15)/(19,15) e (14,15)/(16,15).
- Indoors: mesa longa 3×2 (0..2,0..1) (coluna do meio repete); mesas de 1 linha (4..7,4); oval (3..4,0..1); cadeiras (0,8) frente, (1,8) costas, (2,8) direita, (3,8) esquerda; vasos (16,0),(17,0); sofás 2×1 (14..15,7) laranja, (12..13,7) verde, (14..15,8); poltronas (8,6),(9,6); quadros (19,12..14); painéis 2×1 (20..21,12..14); espelho/quadro branco (22,14..15); passadeiras (16..18,14..17); balcões (0..9,12) com pia (8,12); fogão (14,14); geladeira (14,16..17) a confirmar. Estantes RPG (41..48,12..14).
- **Coordenadas precisam de conferência visual**: o gerador deve emitir uma folha de conferência (PNG com índices) no scratchpad antes de fechar.

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
