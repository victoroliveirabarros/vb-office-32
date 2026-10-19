# Créditos

Assets de terceiros versionados neste repositório e suas licenças.

## Mapa

O tileset do escritório (`web/public/game/office-tiles.png`) é gerado por
`tools/officeart` (`make art`) a partir destas folhas, escaladas 2× sem
alterar os desenhos. Parte dos tiles Kenney é **recolorida** no gerador (troca
de cores origem→destino declarada no manifesto, `Paint` em
`tools/officeart/manifest.go`): paredes brancas/cinza com rodapé grafite,
carpetes azul e cinza-azulado, tapetes e passadeiras neutros, mesas brancas,
sofá azul-marinho, poltronas e assentos amarelos, estantes cinza e quadro
branco. A recoloração é obra derivada de assets CC0, também **CC0 1.0**.

- **Roguelike/RPG pack**, de Kenney Vleugels (https://kenney.nl/assets/roguelike-rpg-pack),
  licença **CC0 1.0** (domínio público; crédito opcional). Zip
  `kenney_roguelike-rpg-pack.zip` publicado em 2023-03-01
  (https://kenney.nl/media/pages/assets/roguelike-rpg-pack/12c03cd78b-1677697420/kenney_roguelike-rpg-pack.zip,
  sha256 `8e7d2378f8f794245645f6d7dc7aeeb246791410a7e512293c594b46a5a9524b`).
  Versionados em `art/kenney/roguelike-rpg-pack/`: `roguelikeSheet_transparent.png`
  (sha256 `808c8d734480bc949b284f3bcc252e87e1ee53b24178791a6838cce6a319c439`) e
  `License.txt` (sha256 `e3158109ad8580ef266db5b00f97bbed853870a99c0721200ef23880bdfd416e`).
- **Roguelike Indoors**, de Kenney Vleugels (https://kenney.nl/assets/roguelike-indoors),
  licença **CC0 1.0**. Zip `kenney_roguelike-indoors.zip` publicado em 2023-12-10
  (https://kenney.nl/media/pages/assets/roguelike-indoors/4d5b520b03-1702169567/kenney_roguelike-indoors.zip,
  sha256 `578cfdb066c4a9de78a52535adaf953728889b2cf268441bd4d338844f7aa586`).
  Versionados em `art/kenney/roguelike-indoors/`: `roguelikeIndoor_transparent.png`
  (sha256 `ade984d5cbe3f16d9e23e6dc516246649de1a7eec2540cf31d53852b690c446f`) e
  `License.txt` (sha256 `c360de4937c17defad37e46d85e3ddfbb3d7feed06058f9f26a11a25625850bb`).
- **Sprites próprios** em `art/custom/` (cadeira de escritório nas 4 direções,
  baias com mesa branca, divisórias e gaveteiro, carpete das baias com moldura
  por estação, monitor com teclado e mouse de frente e de costas, dois
  monitores lado a lado de frente e de costas, notebook, computador, aquário,
  papéis com caneca, livros com celular, luminária, suculenta, planta em vaso,
  porta-retrato, TV de parede 2×1, geladeira, divisórias de vidro com caixilho
  de alumínio, carpete modular do office, porcelanato da copa, piso emborrachado
  do ringue, lona, postes e cordas do ringue, saco de pancada e o tile
  transparente de fora do prédio), desenhados para este projeto na paleta
  Kenney como grades de texto: **CC0 1.0**.

## Avatares

As partes dos avatares (`web/public/game/avatar-parts.png`: corpo, calça,
camisa, 7 estilos de cabelo — um deles careca — e 3 acessórios, nas vistas de baixo, de cima e de lado, parado
e andando) são geradas por `tools/officeart` (`make art`) a partir de
`art/custom/avatar/`, sprites **próprios** desenhados para este projeto como
grades de texto nas cores-chave de `internal/avatar`, recoloridos pelas paletas
do catálogo: **CC0 1.0**.

## Fonte e ícones

- **Montserrat** (variável, pesos 100–900), © 2011 The Montserrat Project Authors
  (https://github.com/JulietaUla/Montserrat), licença **SIL Open Font License 1.1**.
  Arquivos `montserrat-latin-wght-normal.woff2` (sha256
  `06b16db7a969135d48d38c49183be7fb88d4452e2a3011957c7851941f4e4879`) e
  `montserrat-latin-ext-wght-normal.woff2` (sha256
  `54d9a78b7ff60b689ad9f3017ffac8547b5d871afec733f6c1c3ae36577ee504`) de
  `@fontsource-variable/montserrat` 5.3.0, em `web/public/fonts/`, com a licença
  em `web/public/fonts/OFL.txt`.
- **Lucide** 1.59.0 (`lucide-static`, https://lucide.dev), licença **ISC**, © Lucide
  Icons and Contributors; os ícones derivados do Feather (aqui `log-out`, `x`,
  `circle-alert`, antes `alert-circle`, `zoom-in`, `zoom-out`, `map`, `search`,
  `monitor`, `moon` e `lock`) também sob
  **MIT**, © 2013-present Cole Bemis. Sprite `web/public/icons.svg` só com os
  símbolos usados, montado a partir de `icons/*.svg` do pacote sem alterar os
  desenhos; licença completa em `web/public/icons-LICENSE.txt`.
