# Lattice Theme Format

Use a `.json` file with a `name` and a `colors` object. Values must be standard CSS colors.

```json
{
  "name": "Neon Glass Blue",
  "colors": {
    "bg": "#eaf3ff",
    "bg-panel": "rgba(248, 252, 255, 0.42)",
    "bg-subtle": "rgba(225, 237, 252, 0.48)",
    "border": "rgba(255, 255, 255, 0.68)",
    "text": "#18345c",
    "text-secondary": "#4b6682",
    "accent": "#397fe9",
    "accent-hover": "#2369d2",
    "accent-soft": "rgba(69, 133, 235, 0.18)",
    "accent-contrast": "#0f172a",
    "success": "#38a078",
    "warning": "#b98334",
    "danger": "#d45b69"
  }
}
```

Only Lattice color tokens are accepted. Scripts, URLs, arbitrary selectors, and unsupported values are ignored.

## Contrast validation

The importer rejects themes that fail these minimum contrast checks before applying them:

- `text` and `text-secondary` against `bg`, `bg-panel`, and `bg-subtle`: `4.5:1`
- `text-tertiary` against those surfaces: `3:1`
- `accent` and `accent-hover` against those surfaces: `3:1`
- `accent-contrast` against `accent`: `4.5:1`

Opaque hex colors and `rgb()` / `rgba()` / `hsl()` / `hsla()` values are supported. Transparent colors are composited over the declared background before checking. `currentColor` and colors that cannot be resolved to an opaque value are skipped rather than guessed.
