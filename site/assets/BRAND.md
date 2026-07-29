# jmux brand assets

The mark is a **lowercase j**, drawn on a 100 grid: stroke weight 24, dot and
tail both one stroke square, tail reaching 36 left of the stem.

Lowercase because the product name is — the mark is the name, not an
abstraction of it. Two tones, and which tone goes where is the whole idea:
**the stem and tail sit recessed, the dot is lit.** The dot is the state
light, the thing jmux exists to tell you.

Two things are load-bearing:

- **The tail terminal is square.** A 45° cut there turns the tail into a wedge
  and the mark stops reading as a `j` and starts reading as a checkmark.
- **The recessed tone is `#a86e46`, not darker.** It has to stay visible
  against the tile at 16px; push it further down and the favicon becomes a
  floating dot.

**The mark always ships on its own espresso tile.** That is what lets one
asset be correct on the cream site, the dark site, a README, a favicon and an
app icon with no per-surface tuning — and it is why there are no themed colour
variables for the mark. Only the wordmark needs theming, and it takes
`currentColor`.

| File | What it is | Used by |
| --- | --- | --- |
| `logo.svg` | The j on a rounded tile, 64 grid | `README.md` |
| `lockup.svg` | Tile + `jmux` wordmark | standalone / external use |
| `../favicon.svg` | Same tile as `logo.svg` | `index.html` |

`index.html` inlines the lockup rather than linking it, because the site's
theme toggle sets `data-theme` on the root and a media query inside a linked
SVG cannot see that. `lockup.svg` as a file covers the same ground with an
internal `prefers-color-scheme` query, so it adapts wherever it lands.

The inline copies carry **no element ids** — nothing to collide when the same
markup appears twice in one document.

## Raster icons

Regenerated from the vectors, never drawn separately:

- `favicon-96x96.png` — rounded tile, transparent corners
- `favicon.ico` — 48/32/16, all the same mark; a single letter needs no
  simplified small size
- `apple-touch-icon.png` — 180px, full bleed, no alpha (iOS applies its own mask)
- `web-app-manifest-{192,512}.png` — full bleed, mark held inside the maskable
  safe zone (the inner 80% circle)

## Wordmark

`jmux` is set in **Jost 400** and converted to outlines, so the assets carry no
font dependency. Jost is licensed under the SIL Open Font License 1.1
(https://github.com/indestructible-type/Jost).
