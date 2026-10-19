# Créditos

Assets de terceiros versionados neste repositório e suas licenças.

## Mapa

O tileset do escritório (`web/public/game/office-tiles.png`) é gerado por
`tools/officeart` (`make art`) a partir destas folhas, escaladas 2× sem
alterar os desenhos.

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
- **Sprites próprios** em `art/custom/` (monitor de frente, monitor de costas,
  TV de parede 2×1, geladeira, lona, postes e cordas do ringue, saco de pancada
  e o tile transparente de fora do prédio), desenhados para este projeto na
  paleta Kenney como grades de texto: **CC0 1.0**.

## Fonte e ícones

- **Nunito** (variável, pesos 200–1000), © 2014 The Nunito Project Authors
  (https://github.com/googlefonts/nunito), licença **SIL Open Font License 1.1**.
  Arquivos `nunito-latin-wght-normal.woff2` e `nunito-latin-ext-wght-normal.woff2`
  de `@fontsource-variable/nunito` 5.3.0, em `web/public/fonts/`, com a licença
  em `web/public/fonts/OFL.txt`.
- **Lucide** 1.59.0 (`lucide-static`, https://lucide.dev), licença **ISC**, © Lucide
  Icons and Contributors; os ícones derivados do Feather (aqui `log-out`, `x` e
  `circle-alert`, antes `alert-circle`) também sob **MIT**, © 2013-present Cole
  Bemis. Sprite `web/public/icons.svg` só com os símbolos usados, montado a partir
  de `icons/*.svg` do pacote sem alterar os desenhos; licença completa em
  `web/public/icons-LICENSE.txt`.
