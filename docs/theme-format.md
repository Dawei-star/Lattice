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
    "text-secondary": "#5c7395",
    "accent": "#397fe9",
    "accent-hover": "#2369d2",
    "accent-soft": "rgba(69, 133, 235, 0.18)",
    "success": "#38a078",
    "warning": "#b98334",
    "danger": "#d45b69"
  }
}
```

Only Lattice color tokens are accepted. Scripts, URLs, arbitrary selectors, and unsupported values are ignored.
