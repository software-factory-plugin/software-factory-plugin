# Mockery Canvas Authoring Reference (`sf-mockery`)

Detailed reference for authoring Mockery flow-canvas files under `docs/factory/mockups/`. Loaded on demand when generating or editing Mockery screens, tokens, partials, or `flow.json`.

## Project Directory Layout

```text
docs/factory/mockups/
├── flow.json              # Canvas graph: devices, sections, nodes, edges
├── tokens.css             # CSS custom properties inside :host { ... }
├── kit.css                # Shared @layer shared primitives & component styles
├── fonts.css              # Optional @font-face declarations using /assets/... URLs
├── assets/                # Optional local images/fonts (root-relative /assets/...)
├── components/
│   └── <name>.html        # Reusable <x-include> partials (root class .c-<name>)
└── screens/
    └── <id>.html          # Fixed-size static screen fragments (<div class="screen">)
```

> Never create a `CLAUDE.md` file inside `docs/factory/mockups/`.

## Complete CSS Design Tokens (`tokens.css`)

Define CSS variables **only** inside `:host { ... }`. Every screen renders inside its own Shadow Root adopting `tokens.css` and `kit.css` (`@layer shared`).

| Category | Required Custom Properties |
| :--- | :--- |
| **Surfaces & Borders** | `--color-bg`, `--color-surface`, `--color-surface-2`, `--color-border` |
| **Header & Text** | `--color-header`, `--color-on-header`, `--color-text`, `--color-text-muted` |
| **Accent & Semantic** | `--color-accent`, `--color-accent-soft`, `--color-on-accent`, `--color-success`, `--color-success-soft`, `--color-danger`, `--color-danger-soft`, `--color-warning`, `--color-warning-soft` |
| **Typography** | `--font-sans`, `--font-mono`, `--text-xs`, `--text-sm`, `--text-base`, `--text-lg`, `--text-xl`, `--text-2xl`, `--text-3xl`, `--weight-regular`, `--weight-medium`, `--weight-bold` |
| **Spacing & Shape** | `--space-1` through `--space-8`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill`, `--shadow-sm`, `--shadow-md`, `--tap-min: 48px` |

### Mode Token Rules

- **Styled Mode (`fidelity: "styled"`, `tokens_synced_from_ui: true`):**
  - Map `sf-ui` `color_palette`, `typography`, and `border_radius_base` verbatim into `tokens.css`.
  - Align `kit.css` interactive states (`default`, `hover`, `focus`, `active`, `disabled`, `error`) to `sf-ui` component styling specs.
- **Wireframe Mode (`fidelity: "wireframe"`, `tokens_synced_from_ui: false`):**
  - Use neutral grayscale values only (e.g., `#f5f5f5`, `#ffffff`, `#e5e5e5`, `#222222`, `#666666`, `#333333`) with system sans/mono font stacks—zero brand colors.
- **Token Hygiene:**
  - Always use `var(--...)` in `kit.css` and screen `<style>` blocks; raw pixel values are allowed only for layout geometry (column widths, fixed frame heights).
  - Put `@font-face` rules in `fonts.css` using root-relative URLs (`/assets/...`).

## Device Presets & Deterministic Canvas Grid (`flow.json`)

Always write explicit `w` and `h` matching the preset dimensions:

| Preset (`device`) | Width (`w`) | Height (`h`) | Typical Surface |
| :--- | :---: | :---: | :--- |
| `phone` | `390` | `844` | Mobile app / responsive mobile |
| `tablet` | `768` | `1024` | Tablet / iPad layout |
| `pos` | `1280` | `800` | Kiosk / point-of-sale terminal |
| `desktop` | `1440` | `900` | Web dashboard / SaaS app |
| `none` | *(custom)* | *(custom)* | Bare custom frame |

### Node Naming & Placement Rules

- **Node `id`:** kebab-case `<surface>-<screen>[-<variant>]` (e.g., `desktop-checkout`, `desktop-checkout-error`).
- **Node fields:** `{ "id", "title", "file": "screens/<id>.html", "device", "w", "h", "x", "y", "section" }`.
- **Grid Coordinates:**
  - **Row 1 (`y: 0`):** Happy-path screens laid out left-to-right in flow order with **`320px`** horizontal gap between adjacent frame edges (`next_x = prev_x + prev_w + 320`).
  - **Row 2 (`y: 1800`):** First state variant (`empty`, `loading`, or `error`) aligned directly under its parent screen's `x`.
  - **Row 3 (`y: 3600`):** Additional state variants aligned under the same parent `x`.
- **Sections:** `{ "id", "title", "color" }` where `color` is `blue`, `green`, `amber`, `red`, `violet`, `gray`, or any CSS color. Omit `x`/`y`/`w`/`h` so sections auto-size around member nodes.

## Static Screen Markup & Forbidden Constructs

- Structure each `screens/<id>.html` with an optional leading `<style>` block (screen-local overrides only) followed by a single root `<div class="screen">` laid out with flex/grid at its node's exact `w`×`h` CSS pixels.
- **Strictly Forbidden in Screens & Partials:**
  - `<script>` tags or inline JS handlers
  - `@media` queries
  - Viewport units (`vw`, `vh`, `vmin`, `vmax`, `dvh`, `svh`, `lvh`)
  - `position: fixed`

## Interactive Edges (`flow.json` + `data-goto`)

- Put `data-goto="<target-id>"` on the interactive HTML element that triggers navigation, and add a matching edge `{ "from", "to", "label", "style" }` to `flow.json` `edges`.
- Use `"fromSelector"` on an edge **only** when the trigger lives inside a shared `<x-include>` component.
- System-triggered transitions omit `data-goto` / `"fromSelector"` and include `dashed` in `"style"`.
- **Allowed `style` tokens** (space-separated): `dashed`, `error`, `success`, `muted`.
- **Edge labels:** concise, 1–3 words.

## Reusable `<x-include>` Partials

Extract markup repeated across 2+ screens into `components/<name>.html`:

- Invoke in screens via `<x-include src="<name>" prop="value">...</x-include>`.
- Inside partials, interpolate with `{{prop}}`, `{{prop|fallback}}`, and `{{slot}}`.
- Give the partial's root element class `.c-<name>` and place its styles in `kit.css` under a `/* <name> */` comment.
- **Never** put `<style>` blocks inside `components/*.html` partials.

## Granular Iterative Edits

On follow-up user feedback, edit only the smallest affected file (`tokens.css`, `kit.css`, a single component or screen file, or `flow.json`), re-run `node <skill_dir>/scripts/cli.mjs check docs/factory/mockups --json`, and keep `docs/factory/06b-mockery.md` `<system_state>` synchronized with `flow.json`.
